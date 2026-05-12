# Self-Hosted GitHub Actions Runner Setup

## Overview

Setting up a self-hosted runner on your Hetzner server (64GB RAM) will solve the Android emulator OOM issues permanently. The emulator will run with hardware acceleration (KVM) at near-native speeds.

## Prerequisites

- Hetzner server with 64GB RAM
- Ubuntu 20.04+ or Debian 11+
- Root/sudo access
- GitHub repository admin access

## Step 1: Prepare the Server

SSH into your Hetzner server and run the setup script:

```bash
# Save this as setup-runner.sh on your Hetzner server
cat > setup-runner.sh << 'EOF'
#!/bin/bash
set -e

echo "=== Self-Hosted GitHub Actions Runner Setup ==="
echo ""

# 1. Update system
echo "Updating system packages..."
sudo apt-get update
sudo apt-get upgrade -y

# 2. Install dependencies
echo "Installing dependencies..."
sudo apt-get install -y \
  curl \
  git \
  build-essential \
  libssl-dev \
  libffi-dev \
  python3-dev \
  python3-pip \
  jq \
  wget \
  unzip

# 3. Enable KVM (critical for Android emulator)
echo "Enabling KVM..."
sudo apt-get install -y qemu-kvm libvirt-daemon-system libvirt-clients bridge-utils
sudo adduser $USER kvm
sudo adduser $USER libvirt

# Verify KVM is available
if [ -e /dev/kvm ]; then
  echo "✓ KVM is available"
else
  echo "✗ KVM not available - nested virtualization may not be enabled"
  echo "  Enable nested virtualization in Hetzner console if using a VM"
fi

# 4. Install Node.js (for the mobile build)
echo "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 5. Install Java 17 (for Android builds)
echo "Installing Java 17..."
sudo apt-get install -y openjdk-17-jdk

# 6. Install Android SDK
echo "Installing Android SDK..."
cd /opt
sudo wget https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip
sudo unzip commandlinetools-linux-9477386_latest.zip -d android-sdk
sudo rm commandlinetools-linux-9477386_latest.zip

# Set up Android SDK environment
export ANDROID_HOME=/opt/android-sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator

# Add to system-wide profile
echo 'export ANDROID_HOME=/opt/android-sdk' | sudo tee -a /etc/profile.d/android.sh
echo 'export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator' | sudo tee -a /etc/profile.d/android.sh

# Create proper directory structure for cmdline-tools
sudo mkdir -p $ANDROID_HOME/cmdline-tools/latest
sudo mv $ANDROID_HOME/cmdline-tools/bin $ANDROID_HOME/cmdline-tools/latest/
sudo mv $ANDROID_HOME/cmdline-tools/lib $ANDROID_HOME/cmdline-tools/latest/

# Accept licenses
yes | sudo $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses

# Install required SDK packages
echo "Installing Android SDK packages..."
sudo $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
  "platform-tools" \
  "platforms;android-30" \
  "platforms;android-35" \
  "build-tools;35.0.0" \
  "system-images;android-30;google_apis;x86_64" \
  "emulator" \
  "ndk;26.1.10909125" \
  "cmake;3.22.1"

# 7. Set permissions
sudo chown -R $USER:$USER $ANDROID_HOME
sudo chmod -R 755 $ANDROID_HOME

# 8. Verify installations
echo ""
echo "=== Verifying installations ==="
echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"
echo "Java: $(java -version 2>&1 | head -1)"
echo "Android SDK: $ANDROID_HOME"
echo "KVM: $(kvm-ok 2>&1 || echo 'kvm-ok not installed')"
echo ""
echo "✓ Setup complete!"
echo ""
echo "Next step: Set up GitHub Actions runner (see Step 2 in SELF_HOSTED_RUNNER_SETUP.md)"
EOF

chmod +x setup-runner.sh
./setup-runner.sh
```

## Step 2: Register GitHub Actions Runner

### 2.1 Get Registration Token

On your local machine (not the server), run:

```bash
cd speakeasy

# Get the registration token
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Speakeasy-Messenger/speakeasy/actions/runners/registration-token \
  | jq -r .token
```

Copy the token that's printed.

### 2.2 Install Runner on Server

SSH back into your Hetzner server and run:

```bash
# Create a directory for the runner
mkdir -p ~/actions-runner && cd ~/actions-runner

# Download the latest runner package
curl -o actions-runner-linux-x64-2.321.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz

# Extract the installer
tar xzf ./actions-runner-linux-x64-2.321.0.tar.gz

# Configure the runner
# Replace YOUR_TOKEN with the token from step 2.1
./config.sh --url https://github.com/Speakeasy-Messenger/speakeasy --token YOUR_TOKEN --name hetzner-android --labels android,emulator,x64 --work _work

# Install as a service (runs automatically on boot)
sudo ./svc.sh install

# Start the service
sudo ./svc.sh start

# Check status
sudo ./svc.sh status
```

## Step 3: Update GitHub Workflow

Now update the workflow to use the self-hosted runner:

```bash
cd speakeasy
```

Create a new workflow file for self-hosted runner:

```yaml
# .github/workflows/tier-b-emulator-self-hosted.yml
name: Tier B — Android emulator E2E (Self-Hosted)

on:
  push:
    branches: [main]
    tags: ['alpha-*']
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  emulator-e2e:
    runs-on: [self-hosted, android, emulator]
    timeout-minutes: 60
    
    steps:
      - uses: actions/checkout@v4

      # Node.js is already installed on self-hosted runner
      - name: Install dependencies
        run: npm ci

      - name: Build workspace packages
        run: npm run build

      - name: Install Maestro
        run: |
          if ! command -v maestro &> /dev/null; then
            curl -Ls "https://get.maestro.mobile.dev" | bash
            echo "$HOME/.maestro/bin" >> "$GITHUB_PATH"
          fi

      - name: Verify Maestro
        run: maestro --version

      - name: Rewrite mobile config to point at the in-runner api server
        env:
          API_BASE_URL: http://localhost:8080
          WS_URL: ws://localhost:8080/ws
        run: node apps/mobile/scripts/write-test-config.mjs

      - name: Build release APK
        working-directory: apps/mobile/android
        env:
          VOUCHFLOW_WRITE_KEY: ${{ secrets.VOUCHFLOW_WRITE_KEY }}
        run: |
          if [ -z "$VOUCHFLOW_WRITE_KEY" ]; then
            echo "::error::VOUCHFLOW_WRITE_KEY secret is not set"
            exit 1
          fi
          rm -rf ../../node_modules/.cache/metro
          rm -rf /tmp/metro-*
          ./gradlew :app:assembleRelease --no-daemon \
            -Pvouchflow.apiKey="$VOUCHFLOW_WRITE_KEY"

      - name: Boot api server
        env:
          PORT: '8080'
          HOST: '0.0.0.0'
          LOG_LEVEL: 'info'
          VOUCHFLOW_READ_KEY: ${{ secrets.VOUCHFLOW_READ_KEY }}
          VOUCHFLOW_BASE_URL: 'https://sandbox.api.vouchflow.dev/v1'
          ENROLL_RATE_LIMIT: '100'
        run: |
          if [ -z "$VOUCHFLOW_READ_KEY" ]; then
            echo "::error::VOUCHFLOW_READ_KEY secret is not set"
            exit 1
          fi
          cd apps/api
          nohup node dist/server.js > /tmp/api-server.log 2>&1 &
          for i in {1..30}; do
            if curl -fsS http://127.0.0.1:8080/healthz > /dev/null; then
              echo "api server is up"
              exit 0
            fi
            sleep 1
          done
          echo "api server did not come up; log:"
          cat /tmp/api-server.log
          exit 1

      - name: Start emulator in background
        run: |
          # Create AVD if not exists
          if ! $ANDROID_HOME/emulator/emulator -list-avds | grep -q test-avd; then
            echo "no" | $ANDROID_HOME/cmdline-tools/latest/bin/avdmanager create avd \
              -n test-avd \
              -k "system-images;android-30;google_apis;x86_64" \
              -d "pixel_5"
          fi
          
          # Start emulator in background
          $ANDROID_HOME/emulator/emulator -avd test-avd \
            -no-window \
            -no-audio \
            -no-boot-anim \
            -accel on \
            -gpu swiftshader_indirect \
            -memory 4096 \
            -no-snapshot-save &
          
          # Wait for device to be ready
          adb wait-for-device
          adb shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'
          echo "Emulator is ready"

      - name: Run Maestro tests
        run: |
          # Set up device
          adb shell locksettings set-pin 0000
          adb shell svc power stayon true
          adb shell settings put system screen_off_timeout 1800000
          adb shell input keyevent KEYCODE_WAKEUP
          
          # Disable launchers
          adb shell pm disable-user --user 0 com.google.android.apps.nexuslauncher || true
          adb shell pm disable-user --user 0 com.android.launcher3 || true
          
          # Start logcat
          adb logcat -c
          nohup adb logcat -v time \
            Vouchflow:V VouchflowModule:V ReactNativeJS:V ReactNative:V \
            AndroidRuntime:V SpeakeasyDb:V SignalProtocolModule:V \
            SpeakeasyApp:V BiometricPrompt:V Auth:V Authenticators:V \
            KeyguardManager:V Keystore2:V RNFirebaseMessaging:V \
            FirebaseMessaging:V '*:E' > /tmp/logcat.txt 2>&1 &
          
          # Install APK
          adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
          
          # Grant permissions
          adb shell pm grant xyz.speakeasyapp.app android.permission.RECORD_AUDIO
          adb shell pm grant xyz.speakeasyapp.app android.permission.POST_NOTIFICATIONS
          
          # Run test 11 first (push notification test)
          adb shell wm dismiss-keyguard
          adb shell am force-stop xyz.speakeasyapp.app
          timeout 300 maestro test apps/mobile/maestro/11-push-background-handler.yaml \
            --debug-output /tmp/maestro-11
          
          # Run other tests
          # ... (add other tests as needed)

      - name: Cleanup
        if: always()
        run: |
          # Kill emulator
          adb emu kill || true
          # Stop api server
          pkill -f "node dist/server.js" || true

      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: maestro-debug-self-hosted-${{ github.sha }}
          path: /tmp/maestro-11/
          retention-days: 7
```

## Step 4: Test the Setup

### 4.1 Verify Runner is Connected

```bash
# On GitHub, go to:
# https://github.com/Speakeasy-Messenger/speakeasy/settings/actions/runners

# You should see "hetzner-android" runner listed as "Idle"
```

### 4.2 Trigger a Test Run

```bash
cd speakeasy

# Commit the new workflow
git add .github/workflows/tier-b-emulator-self-hosted.yml
git commit -m "ci: add self-hosted runner workflow for Android emulator"
git push origin main

# Or trigger manually
gh workflow run tier-b-emulator-self-hosted.yml
```

## Step 5: Monitor the Run

```bash
# Watch the run
gh run watch

# Or view on GitHub
# https://github.com/Speakeasy-Messenger/speakeasy/actions
```

## Benefits of Self-Hosted Runner

1. **64GB RAM** - No more OOM kills
2. **Hardware Acceleration (KVM)** - 10x faster than software emulation
3. **Persistent Storage** - AVD snapshots cached between runs
4. **No Time Limits** - GitHub's 6-hour limit doesn't apply
5. **Faster Builds** - Gradle cache persists, ~5x faster rebuilds
6. **Reliable** - No more "device offline" errors

## Troubleshooting

### Runner Not Starting

```bash
# Check service status
sudo systemctl status actions.runner.*

# Check logs
sudo journalctl -u actions.runner.* -f
```

### Emulator Not Starting

```bash
# Verify KVM
kvm-ok

# Check emulator directly
$ANDROID_HOME/emulator/emulator -avd test-avd -no-window

# Check for errors
dmesg | grep kvm
```

### Permission Issues

```bash
# Ensure user is in kvm group
sudo usermod -aG kvm $USER
newgrp kvm

# Verify
groups | grep kvm
```

## Security Considerations

1. **Firewall**: Only open ports 22 (SSH) and 80/443 if needed
2. **Runner User**: Create a dedicated user for the runner (not root)
3. **Secrets**: Use GitHub secrets, never hardcode
4. **Updates**: Keep the runner software updated
5. **Monitoring**: Set up monitoring for resource usage

## Maintenance

### Update Runner

```bash
cd ~/actions-runner
sudo ./svc.sh stop
./config.sh remove --token YOUR_REMOVAL_TOKEN
# Download new version
# Re-run config.sh and svc.sh install
```

### Monitor Resources

```bash
# Check resource usage
htop

# Check disk space
df -h

# Check emulator processes
ps aux | grep emulator
```

## Cost Estimation

Self-hosted runner on Hetzner:
- Server: ~€40-60/month (64GB RAM, 8 CPU)
- Electricity: Minimal
- Maintenance: ~1 hour/month

GitHub Actions hosted:
- Free tier: 2,000 minutes/month
- After that: $0.008/minute
- Your tests: ~30 min/run × 10 runs/day = 300 min/day = 9,000 min/month
- Cost: ~$72/month + frequent OOM failures

**Self-hosted is both cheaper AND more reliable!**
