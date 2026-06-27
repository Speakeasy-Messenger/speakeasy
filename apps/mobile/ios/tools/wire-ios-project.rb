#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Wire the iOS app target's runtime config into the Xcode project. Run on the
# Mac after `gem install xcodeproj` (the fastlane bundle already ships it):
#
#   cd apps/mobile/ios && ruby tools/wire-ios-project.rb
#
# Idempotent — safe to re-run. Applies three fixes the committed project is
# missing (see the iOS audit, 2026-06):
#
#   1. CODE_SIGN_ENTITLEMENTS = Speakeasy/Speakeasy.entitlements on Debug +
#      Release, so the aps-environment (push) + associated-domains (universal
#      links) entitlements actually sign into the build.
#   2. GoogleService-Info.plist in Copy Bundle Resources, so [FIRApp configure]
#      finds it at launch (without it the app throws "No Firebase App
#      '[DEFAULT]'" and push is dead / launch can crash).
#   3. Vouchflow.plist in Copy Bundle Resources, so the Vouchflow bootstrap
#      reads the real API key instead of the placeholder fallback.
#
# The two plists are gitignored (real values provisioned per-environment); the
# refs are added regardless — Xcode resolves them at build time.

require 'xcodeproj'

IOS_DIR = File.expand_path('..', __dir__) # apps/mobile/ios (script is in ios/tools)
PROJECT = File.expand_path('Speakeasy.xcodeproj', IOS_DIR)
TARGET_NAME = 'Speakeasy'
ENTITLEMENTS = 'Speakeasy/Speakeasy.entitlements'
RESOURCE_PLISTS = ['GoogleService-Info.plist', 'Vouchflow.plist'].freeze
# Brand fonts (BricolageGrotesque) live in Speakeasy/Fonts/ and are declared in
# Info.plist's UIAppFonts. They only resolve at runtime if they're also in the
# app target's Copy Bundle Resources — otherwise iOS silently falls back to the
# system font (Android bundles them via android/app/src/main/assets/fonts).
FONT_FILES = [
  'BricolageGrotesque-Regular.ttf',
  'BricolageGrotesque-Medium.ttf',
  'BricolageGrotesque-SemiBold.ttf',
  'BricolageGrotesque-Bold.ttf',
  'BricolageGrotesque-ExtraBold.ttf'
].freeze

project = Xcodeproj::Project.open(PROJECT)
target = project.targets.find { |t| t.name == TARGET_NAME }
raise "target #{TARGET_NAME} not found" unless target

# Anchor on AppDelegate.mm — it lives in the Speakeasy group whose source-tree
# path resolves to ios/Speakeasy, so new siblings get the correct on-disk path
# (the prior hand-patch put refs at ios/<name>, which broke the build).
anchor = project.files.find { |f| f.display_name == 'AppDelegate.mm' }
raise 'AppDelegate.mm reference not found — cannot locate Speakeasy group' unless anchor
group = anchor.parent

changed = []

RESOURCE_PLISTS.each do |fname|
  ref = group.files.find { |f| f.display_name == fname }
  if ref.nil?
    # Pass the ABSOLUTE on-disk path (ios/Speakeasy/<fname>) so xcodeproj
    # computes the correct group-relative path. The Speakeasy group is
    # pathless (resolves to ios/) and its files carry "Speakeasy/…" paths,
    # so a bare filename would wrongly land at ios/<fname> (the prior bug).
    ref = group.new_reference(File.join(IOS_DIR, 'Speakeasy', fname))
    changed << "added file ref #{fname}"
  end

  # Verify the ref resolves under ios/Speakeasy/ (guard against the old bug).
  resolved = ref.real_path.to_s
  unless resolved.end_with?("/Speakeasy/#{fname}")
    raise "BAD PATH for #{fname}: #{resolved} (expected …/Speakeasy/#{fname})"
  end

  in_resources = target.resources_build_phase.files_references.include?(ref)
  unless in_resources
    target.add_resources([ref])
    changed << "added #{fname} to Copy Bundle Resources"
  end
end

FONT_FILES.each do |fname|
  ref = group.files.find { |f| f.display_name == fname }
  if ref.nil?
    # Same path discipline as the plists above: pass the ABSOLUTE on-disk path
    # (ios/Speakeasy/Fonts/<fname>) so xcodeproj derives the right group-
    # relative path ("Speakeasy/Fonts/<fname>") off the pathless Speakeasy
    # group. A bare filename would wrongly resolve to ios/<fname>.
    ref = group.new_reference(File.join(IOS_DIR, 'Speakeasy', 'Fonts', fname))
    changed << "added file ref #{fname}"
  end

  # Verify the ref resolves under ios/Speakeasy/Fonts/ (guard against bad path).
  resolved = ref.real_path.to_s
  unless resolved.end_with?("/Speakeasy/Fonts/#{fname}")
    raise "BAD PATH for #{fname}: #{resolved} (expected …/Speakeasy/Fonts/#{fname})"
  end

  in_resources = target.resources_build_phase.files_references.include?(ref)
  unless in_resources
    target.add_resources([ref])
    changed << "added #{fname} to Copy Bundle Resources"
  end
end

target.build_configurations.each do |config|
  current = config.build_settings['CODE_SIGN_ENTITLEMENTS']
  next if current == ENTITLEMENTS

  config.build_settings['CODE_SIGN_ENTITLEMENTS'] = ENTITLEMENTS
  changed << "set CODE_SIGN_ENTITLEMENTS (#{config.name})"
end

# Embed the VouchflowSDK Swift-package framework. It's a DYNAMIC framework,
# and the project links it (packageProductDependencies + Frameworks phase)
# but never embeds it — so neither `xcodebuild build` nor an archive copies
# it into .app/Frameworks, and the app dies at launch with
#   dyld: Library not loaded: @rpath/VouchflowSDK.framework/VouchflowSDK
# Adding it to an "Embed Frameworks" copy phase (CodeSignOnCopy) fixes both
# device archives and simulator builds. (Caught when the sim build crashed
# 2026-06-21 — the uploaded TestFlight builds had the same gap.)
prod = target.package_product_dependencies.find { |d| d.product_name == 'VouchflowSDK' }
if prod.nil?
  puts 'wire-ios-project: WARN VouchflowSDK package product dependency not found — skipping embed'
else
  embed = target.copy_files_build_phases.find do |p|
    p.symbol_dst_subfolder_spec == :frameworks && p.name == 'Embed Frameworks'
  end
  if embed.nil?
    embed = target.new_copy_files_build_phase('Embed Frameworks')
    embed.symbol_dst_subfolder_spec = :frameworks
    changed << 'created Embed Frameworks phase'
  end
  embedded = embed.files.any? do |bf|
    bf.respond_to?(:product_ref) && bf.product_ref && bf.product_ref.product_name == 'VouchflowSDK'
  end
  unless embedded
    bf = project.new(Xcodeproj::Project::Object::PBXBuildFile)
    bf.product_ref = prod
    bf.settings = { 'ATTRIBUTES' => %w[CodeSignOnCopy RemoveHeadersOnCopy] }
    embed.files << bf
    changed << 'embedded VouchflowSDK.framework (CodeSignOnCopy)'
  end

  # Position the Embed Frameworks phase right after the Frameworks (Link
  # Binary) phase — Xcode's conventional spot. Appended at the END it forms a
  # build cycle with the RNFB / Info.plist script phases ("Cycle inside
  # Speakeasy; building could produce unreliable results").
  fw_phase = target.frameworks_build_phase
  fw_idx = target.build_phases.index(fw_phase)
  desired = fw_idx + 1
  cur_idx = target.build_phases.index(embed)
  if cur_idx != desired
    target.build_phases.delete_at(cur_idx)
    fw_idx = target.build_phases.index(fw_phase) # recompute after delete
    target.build_phases.insert(fw_idx + 1, embed)
    changed << 'positioned Embed Frameworks after Link Binary (cycle fix)'
  end
end

# Ensure newly-added native Swift bridge files are in the compile sources.
# The SpeakeasyBridges/*.swift files are referenced individually in the
# project (not via a folder reference), so a file authored on Linux won't
# build until it's added to its group + the target's Sources phase. This
# wires any such file generically: for each .swift under SpeakeasyBridges/,
# if no source-build file references it, add it to the group of a sibling
# already in the project. Idempotent. (Added for DecryptCache.swift — the
# iOS port of Android's idempotent-decrypt cache.)
built_swift = target.source_build_phase.files_references.map { |f| f.real_path.to_s }
Dir.glob(File.join(IOS_DIR, 'SpeakeasyBridges', '**', '*.swift')).sort.each do |swift_path|
  next if built_swift.include?(swift_path)
  fname = File.basename(swift_path)
  dir = File.dirname(swift_path)
  # Anchor on a sibling .swift already in the project to find the right group.
  sibling = project.files.find do |f|
    f.real_path.to_s != swift_path &&
      f.display_name.end_with?('.swift') &&
      File.dirname(f.real_path.to_s) == dir
  end
  unless sibling
    puts "wire-ios-project: WARN no sibling group found for #{fname} — skipping (add it in Xcode once)"
    next
  end
  group = sibling.parent
  ref = group.files.find { |f| f.display_name == fname } || group.new_reference(fname)
  target.add_file_references([ref]) unless target.source_build_phase.files_references.include?(ref)
  changed << "added #{fname} to Sources (#{File.basename(dir)} group)"
end

# ---------------------------------------------------------------------------
# Share read module — ShareReceiveModule.{swift,m} live in a brand-new
# SpeakeasyBridges/Share dir with no sibling already in the project, so the
# generic .swift loop above can't anchor them (and it ignores .m entirely).
# Add both to the app target's Sources with absolute-path refs (xcodeproj
# derives the right group-relative path). Reuse the Speakeasy group.
speakeasy_group = project.files.find { |f| f.display_name == 'AppDelegate.mm' }&.parent
if speakeasy_group
  %w[
    SpeakeasyBridges/Share/ShareReceiveModule.swift
    SpeakeasyBridges/Share/ShareReceiveModule.m
  ].each do |rel|
    abs = File.join(IOS_DIR, rel)
    fname = File.basename(rel)
    ref = project.files.find { |f| f.real_path.to_s == abs } ||
          speakeasy_group.new_reference(abs)
    unless target.source_build_phase.files_references.include?(ref)
      target.add_file_references([ref])
      changed << "added #{fname} to app Sources"
    end
  end
end

# ---------------------------------------------------------------------------
# Share Extension target ("Share → Speakeasy"). Created here — no Xcode GUI.
# The PR's ios-build (simulator) runs this script + xcodebuild, so a bad
# mutation surfaces there; release signing (match) is wired separately.
EXT_NAME = 'ShareExtension'
ext = project.targets.find { |t| t.name == EXT_NAME }
if ext.nil?
  deployment =
    target.build_configurations.first.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] || '15.1'
  ext = project.new_target(:app_extension, EXT_NAME, :ios, deployment, nil, :swift)
  changed << 'created ShareExtension target'
end
# Name the product explicitly — without PRODUCT_NAME the target builds an
# unnamed ".appex" and the embed step trips "Multiple commands produce .appex".
ext.product_reference.name = "#{EXT_NAME}.appex"
ext.product_reference.path = "#{EXT_NAME}.appex"

ext_group = project.main_group.groups.find { |g| g.display_name == EXT_NAME } ||
            project.main_group.new_group(EXT_NAME, EXT_NAME)
sw_ref = ext_group.files.find { |f| f.display_name == 'ShareViewController.swift' } ||
         ext_group.new_reference(File.join(IOS_DIR, EXT_NAME, 'ShareViewController.swift'))
unless ext.source_build_phase.files_references.include?(sw_ref)
  ext.add_file_references([sw_ref])
end
['Info.plist', 'ShareExtension.entitlements'].each do |fname|
  next if ext_group.files.find { |f| f.display_name == fname }
  ext_group.new_reference(File.join(IOS_DIR, EXT_NAME, fname))
end

swift_ver = target.build_configurations.first.build_settings['SWIFT_VERSION'] || '5.0'
ext.build_configurations.each do |config|
  bs = config.build_settings
  bs['PRODUCT_NAME'] = '$(TARGET_NAME)'
  bs['PRODUCT_BUNDLE_IDENTIFIER'] = 'xyz.speakeasyapp.app.ShareExtension'
  bs['INFOPLIST_FILE'] = "#{EXT_NAME}/Info.plist"
  bs['CODE_SIGN_ENTITLEMENTS'] = "#{EXT_NAME}/ShareExtension.entitlements"
  bs['SWIFT_VERSION'] = swift_ver
  bs['TARGETED_DEVICE_FAMILY'] = '1'
  bs['SKIP_INSTALL'] = 'YES'
  bs['GENERATE_INFOPLIST_FILE'] = 'NO'
  bs['MARKETING_VERSION'] = '1.0'
  bs['CURRENT_PROJECT_VERSION'] = '1'
  bs['LD_RUNPATH_SEARCH_PATHS'] =
    ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
end

# Depend on + embed the .appex into the app's PlugIns.
target.add_dependency(ext) unless target.dependencies.any? { |d| d.target == ext }
embed = target.copy_files_build_phases.find { |p| p.symbol_dst_subfolder_spec == :plug_ins }
if embed.nil?
  embed = target.new_copy_files_build_phase('Embed App Extensions')
  embed.symbol_dst_subfolder_spec = :plug_ins
  changed << 'created Embed App Extensions phase'
end
unless embed.files.any? { |bf| bf.respond_to?(:file_ref) && bf.file_ref == ext.product_reference }
  bf = embed.add_file_reference(ext.product_reference)
  bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  changed << 'embedded ShareExtension.appex'
end

if changed.empty?
  puts 'wire-ios-project: already wired — no changes'
else
  project.save
  puts 'wire-ios-project: applied:'
  changed.each { |c| puts "  - #{c}" }
end
