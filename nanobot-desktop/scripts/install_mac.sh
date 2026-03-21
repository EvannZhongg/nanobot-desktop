#!/usr/bin/env bash

# Nanobot Desktop macOS Auto Updater & Installer
set -e

echo "🚀 [1/4] Pulling latest code from Git..."
git pull origin main || echo "⚠️ Git pull failed or skipped (you might have uncommitted changes)."

echo "📦 [2/4] Installing dependencies..."
npm install
cd src-tauri && cargo fetch && cd ..

echo "🔨 [3/4] Building production release..."
npm run tauri build

echo "💻 [4/4] Installing application to /Applications..."
APP_SOURCE="src-tauri/target/release/bundle/macos/Nanobot Desktop.app"
APP_TARGET="/Applications/Nanobot Desktop.app"

if [ -d "$APP_SOURCE" ]; then
    echo "=> Removing old version..."
    rm -rf "$APP_TARGET"
    echo "=> Copying new version to /Applications..."
    cp -R "$APP_SOURCE" "/Applications/"
    echo "✅ Successfully installed Nanobot Desktop!"
    echo "🎉 You can now press Cmd+Space and search for 'Nanobot Desktop' to launch it."
else
    echo "❌ Error: Built app not found at $APP_SOURCE"
    exit 1
fi
