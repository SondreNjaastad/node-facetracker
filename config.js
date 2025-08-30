// config.js - Configuration for face tracking

module.exports = {
  // Camera settings
  camera: {
    device: process.env.CAM_DEVICE ?? "0",
    fps: process.env.CAM_FPS ?? "50",
    sizes: process.env.CAM_SIZES ?? "1280x720,848x480,1920x1080",
    pixelFormats: process.env.CAM_PIXF ?? "nv12,uyvy422,yuyv422,yuv420p"
  },
  
  // Display settings
  display: {
    showViewer: (process.env.SHOW_VIEWER ?? "1") !== "0",
    crosshairSize: 20,
    crosshairThickness: 2,
    crosshairColor: { r: 255, g: 0, b: 0, a: 255 }, // Red
    faceBoxColor: { r: 0, g: 255, b: 0, a: 255 },   // Green
    faceBoxThickness: 3
  },
  
  // Camera control settings
  cameraControl: {
    enabled: (process.env.ENABLE_CAMERA_CONTROL ?? "1") !== "0",
    ip: process.env.CAMERA_IP ?? "10.0.1.14",
    panTiltGain: 1.0,        // How sensitive the tracking is (0.1 to 1.0) - increased for faster movement
    deadZone: 0.05,          // Minimum offset to trigger movement
    updateRate: 10           // How often to send commands (frames)
  },
  
  // Face tracking settings
  tracking: {
    iouThreshold: 0.3,       // Intersection over Union threshold for tracking
    trackTTL: 30,            // How long to remember a track (frames)
    maxFaces: 5              // Maximum number of faces to track
  }
};
