//
//  ShareViewController.swift
//  ShareExtension — "Share → Speakeasy" target on iOS.
//
//  Captures shared text/URLs from the system share sheet, writes them to the
//  App Group container shared with the main app, and finishes. The main app
//  reads `pendingShareText` from the same App Group on next foreground
//  (ShareReceiveModule) and routes to the conversation picker — same flow as
//  the Android share target.
//
//  No compose UI: NSExtensionPrincipalClass points here (programmatic, no
//  storyboard). We grab the payload and dismiss immediately.
//
//  App Group: group.xyz.speakeasyapp.app (also on the main app's entitlements).
//

import UIKit
import UniformTypeIdentifiers

@objc(ShareViewController)
final class ShareViewController: UIViewController {

  private static let appGroup = "group.xyz.speakeasyapp.app"
  private static let key = "pendingShareText"

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    handleShare()
  }

  private func handleShare() {
    guard
      let item = extensionContext?.inputItems.first as? NSExtensionItem,
      let attachments = item.attachments
    else {
      complete()
      return
    }

    let group = DispatchGroup()
    var shared: String?

    for provider in attachments {
      // Prefer a URL (links are the common share); fall back to plain text.
      if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
        group.enter()
        provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { data, _ in
          if let url = data as? URL { shared = url.absoluteString }
          group.leave()
        }
      } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
        group.enter()
        provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { data, _ in
          if let text = data as? String { shared = text }
          group.leave()
        }
      }
    }

    group.notify(queue: .main) { [weak self] in
      if let value = shared, !value.isEmpty {
        UserDefaults(suiteName: ShareViewController.appGroup)?
          .set(value, forKey: ShareViewController.key)
      }
      self?.complete()
    }
  }

  private func complete() {
    extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
  }
}
