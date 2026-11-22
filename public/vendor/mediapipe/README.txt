MediaPipe Tasks Vision Web SDK 0.10.35
Package: https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.35.tgz
npm integrity: sha512-HOvadwVRE6JC+45nyYhmnywnr5h/J8KZvOeUNVOG9q/0875pZgItznFB9bRTvLc264YSJqiZ1NsIpCStJw/egg==
SDK license: Apache 2.0. The included LICENSE is from
https://github.com/google-ai-edge/mediapipe/blob/v0.10.35/LICENSE

The browser entry point is vision_bundle.mjs. The wasm directory holds the
unmodified SIMD and non-SIMD loader/binary pairs selected by forVisionTasks.
The module-worker WASM variant is unused by this main-thread integration.

Face Landmarker model: float16, revision 1
Source: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
SHA-256: 64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff

The npm archive and model were downloaded to a temporary directory before the
runtime files were copied here. The application fetches these files from its own
origin at runtime.
