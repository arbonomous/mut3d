#!/bin/sh
# Re-fetches the face-model files into public/mp and checks them against mp.sha256. The files are also committed, so this is only needed to verify or restore them. Pinned and checked.
set -e
mkdir -p public/mp/wasm /tmp/mp && cd /tmp/mp
npm pack @mediapipe/tasks-vision@1.1.0 >/dev/null && tar xzf mediapipe-tasks-vision-1.1.0.tgz
curl -sfo selfie_segmenter.tflite https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
curl -sfo face_landmarker.task https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
cd - >/dev/null
cp /tmp/mp/package/vision_bundle.mjs public/mp/
cp /tmp/mp/package/wasm/vision_wasm_internal.* /tmp/mp/package/wasm/vision_wasm_nosimd_internal.* public/mp/wasm/
cp /tmp/mp/face_landmarker.task /tmp/mp/selfie_segmenter.tflite public/mp/
cd public/mp && sha256sum -c ../../mp.sha256
