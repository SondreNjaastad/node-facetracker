{
  "targets": [
    {
      "target_name": "faceaddon",
      "sources": [
        "src/addon.cc",
        "vendor/libfacedetection/src/facedetectcnn.cpp",
        "vendor/libfacedetection/src/facedetectcnn-model.cpp",
        "vendor/libfacedetection/src/facedetectcnn-data.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "vendor/libfacedetection/src",
        "src",
        "<!(pkg-config --cflags-only-I opencv4 | sed -e 's/-I//g')"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-O2",
        "-frtti",
        "-fexceptions",
        "-fno-strict-aliasing",
        "-fno-vectorize",
        "-fno-slp-vectorize"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "USE_NEON=0"
      ],
      "libraries": [
        "<!(pkg-config --libs opencv4)"
      ],
      "conditions": [
        [ "OS==\"mac\"", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_RTTI": "YES",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "OTHER_CPLUSPLUSFLAGS": [ "-std=c++17" ],
            "MACOSX_DEPLOYMENT_TARGET": "12.0"
          }
        } ]
      ]
    }
  ]
}
