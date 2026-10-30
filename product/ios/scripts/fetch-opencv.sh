#!/bin/sh
# Downloads the official OpenCV iOS framework into Frameworks/ (about 100 MB, not kept in git).
set -e
cd "$(dirname "$0")/.."
VER=4.10.0
mkdir -p Frameworks
if [ -d Frameworks/opencv2.framework ]; then echo "already there"; exit 0; fi
curl -L -o Frameworks/opencv.zip "https://github.com/opencv/opencv/releases/download/$VER/opencv-$VER-ios-framework.zip"
unzip -q Frameworks/opencv.zip -d Frameworks
rm Frameworks/opencv.zip
ls Frameworks
