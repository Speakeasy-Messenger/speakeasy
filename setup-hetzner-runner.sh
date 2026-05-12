#!/bin/bash
# Self-Hosted GitHub Actions Runner Setup for Hetzner Server
# Run this on your Hetzner server as a non-root user with sudo access

set -e

echo "=== GitHub Actions Self-Hosted Runner Setup ==="
echo ""
echo "This script will:"
echo "  1. Install dependencies (Node.js, Java, Android SDK)"
echo "  2. Enable KVM for hardware acceleration"
echo "  3. Set up GitHub Actions runner"
echo "  4. Configure as a systemd service"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# -----------------------------------------------------------------------------
# 1. Update system
# -----------------------------------------------------------------------------
echo ""
echo "Step 1: Updating system packages..."
sudo apt-get update
sudo apt-get upgrade -y

# -----------------------------------------------------------------------------
# 2. Install dependencies
# -----------------------------------------------------------------------------
echo ""
echo "Step 2: Installing dependencies..."
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
  unzip \
  cpu-checker

# -----------------------------------------------------------------------------
# 3. Enable KVM
# -----------------------------------------------------------------------------
echo ""
echo "Step 3: Enabling KVM..."
sudo apt-get install -y qemu-kvm libvirt-daemon-system libvirt-clients bridge-utils
sudo adduser $USER kvm
sudo adduser $USER libvirt

# Verify KVM
if [ -e /dev/kvm ]; then
  echo "✓ KVM is available"
  kvm-ok || true
else
  echo "✗ KVM not available"
  echo "  You may need to enable nested virtualization in Hetzner console"
  echo "  Or reboot after adding user to kvm group"
  read -p "Continue anyway? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      exit 1
  fi
fi

# -----------------------------------------------------------------------------
# 4. Install Node.js 20
# -----------------------------------------------------------------------------
echo ""
echo "Step 4: Installing Node.js 20..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "✓ Node.js installed: $(node --version)"
else
  echo "✓ Node.js already installed: $(node --version)"
fi

# -----------------------------------------------------------------------------
# 5. Install Java 17
# -----------------------------------------------------------------------------
echo ""
echo "Step 5: Installing Java 17..."
if ! command -v java &> /dev/null; then
  sudo apt-get install -y openjdk-17-jdk
  echo "✓ Java installed: $(java -version 2>&1 | head -1)"
else
  echo "✓ Java already installed: $(java -version 2>&1 | head -1)"
fi

# -----------------------------------------------------------------------------
# 6. Install Android SDK
# -----------------------------------------------------------------------------
echo ""
echo "Step 6: Installing Android SDK..."

export ANDROID_HOME=$HOME/android-sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator

if [ ! -d "$ANDROID_HOME" ]; then
  mkdir -p $ANDROID_HOME
  cd $ANDROID_HOME
  
  # Download command-line tools
  wget https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip
  unzip commandlinetools-linux-9477386_latest.zip
  rm commandlinetools-linux-9477386_latest.zip
  
  # Create proper directory structure
  mkdir -p cmdline-tools/latest
  mv cmdline-tools/bin cmdline-tools/latest/ || true
  mv cmdline-tools/lib cmdline-tools/latest/ || true
  mv cmdline-tools/NOTICE.txt cmdline-tools/latest/ || true
  mv cmdline-tools/source.properties cmdline-tools/latest/ || true
  
  # Add to bash profile
  echo "" >> ~/.bashrc
  echo "# Android SDK" >> ~/.bashrc
  echo "export ANDROID_HOME=$ANDROID_HOME" >> ~/.bashrc
  echo "export PATH=\$PATH:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/emulator" >> ~/.bashrc
  
  # Accept licenses
  yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
  
  # Install required packages
  echo "Installing Android SDK packages (this may take 10-15 minutes)..."
  $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
    "platform-tools" \
    "platforms;android-30" \
    "platforms;android-35" \
    "build-tools;35.0.0" \
    "system-images;android-30;google_apis;x86_64" \
    "emulator" \
    "ndk;26.1.10909125" \
    "cmake;3.22.1"
  
  echo "✓ Android SDK installed at $ANDROID_HOME"
else
  echo "✓ Android SDK already installed at $ANDROID_HOME"
fi

# -----------------------------------------------------------------------------
# 7. Create AVD
# -----------------------------------------------------------------------------
echo ""
echo "Step 7: Creating Android Virtual Device..."

if ! $ANDROID_HOME/emulator/emulator -list-avds | grep -q github-actions-avd; then
  echo "no" | $ANDROID_HOME/cmdline-tools/latest/bin/avdmanager create avd \
    -n github-actions-avd \
    -k "system-images;android-30;google_apis;x86_64" \
    -d "pixel_5"
  
  # Optimize AVD config for CI
  AVD_CONFIG="$HOME/.android/avd/github-actions-avd.avd/config.ini"
  if [ -f "$AVD_CONFIG" ]; then
    # Reduce RAM to prevent OOM
    sed -i 's/hw.ramSize=.*/hw.ramSize=2048/' "$AVD_CONFIG"
    # Disable unnecessary hardware
    echo "hw.camera.back=no" >> "$AVD_CONFIG"
    echo "hw.camera.front=no" >> "$AVD_CONFIG"
    echo "hw.gps=no" >> "$AVD_CONFIG"
  fi
  
  echo "✓ AVD created: github-actions-avd"
else
  echo "✓ AVD already exists: github-actions-avd"
fi

# -----------------------------------------------------------------------------
# 8. Set up GitHub Actions Runner
# -----------------------------------------------------------------------------
echo ""
echo "Step 8: Setting up GitHub Actions runner..."
echo ""
echo "You need to get a registration token from GitHub."
echo "Run this command on your LOCAL machine (not this server):"
echo ""
echo "  gh api \\"
echo "    --method POST \\"
echo "    -H 'Accept: application/vnd.github+json' \\"
echo "    /repos/Speakeasy-Messenger/speakeasy/actions/runners/registration-token \\"
echo "    | jq -r .token"
echo ""
read -p "Enter the registration token: " GITHUB_TOKEN

if [ -z "$GITHUB_TOKEN" ]; then
  echo "No token provided. Skipping runner setup."
  echo "You can run this step manually later."
  exit 0
fi

# Create runner directory
mkdir -p ~/actions-runner && cd ~/actions-runner

# Download latest runner
RUNNER_VERSION="2.321.0"
if [ ! -f "actions-runner-linux-x64-$RUNNER_VERSION.tar.gz" ]; then
  curl -o actions-runner-linux-x64-$RUNNER_VERSION.tar.gz \
    -L https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz
  tar xzf ./actions-runner-linux-x64-$RUNNER_VERSION.tar.gz
fi

# Configure runner
./config.sh \
  --url https://github.com/Speakeasy-Messenger/speakeasy \
  --token $GITHUB_TOKEN \
  --name hetzner-android \
  --labels android,emulator,x64,self-hosted \
  --work _work \
  --unattended

# Install as service
sudo ./svc.sh install

# Start service
sudo ./svc.sh start

# Check status
sudo ./svc.sh status

echo ""
echo "✓ Runner setup complete!"
echo ""
echo "The runner is now registered and running as a systemd service."
echo "It will automatically start on boot."
echo ""
echo "Check status: sudo systemctl status actions.runner.*"
echo "View logs: sudo journalctl -u actions.runner.* -f"
echo ""
echo "Next: Push changes to trigger a CI run on this runner!"
