#include <napi.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <opencv2/opencv.hpp>
#include "facedetectcnn.h"

namespace {

struct Detection {
  float score;
  int x, y, w, h;
  short lm[10];
};

class DetectWorker : public Napi::AsyncWorker {
public:
  DetectWorker(
    Napi::Env env,
    Napi::Buffer<uint8_t> buffer,
    int width, int height, int stride,
    std::string format)
    : Napi::AsyncWorker(env),
      deferred_(Napi::Promise::Deferred::New(env)),
      width_(width), height_(height), stride_(stride), format_(std::move(format))
  {
    // Deep copy input into worker-owned storage
    rgba_.resize(static_cast<size_t>(height_) * stride_);
    std::memcpy(rgba_.data(), buffer.Data(), rgba_.size());

    // Keep a ref to prevent GC of the original (belt + suspenders)
    bufRef_ = Napi::Persistent(buffer);
  }

  ~DetectWorker() override {}

  void Execute() override {
    try {
      // Wrap private copy
      cv::Mat src;
      if (format_ == "rgba") {
        src = cv::Mat(height_, width_, CV_8UC4, rgba_.data(), stride_);
      } else if (format_ == "rgb") {
        src = cv::Mat(height_, width_, CV_8UC3, rgba_.data(), stride_);
      } else if (format_ == "bgr") {
        src = cv::Mat(height_, width_, CV_8UC3, rgba_.data(), stride_);
      } else if (format_ == "bgra") {
        src = cv::Mat(height_, width_, CV_8UC4, rgba_.data(), stride_);
      } else {
        throw std::runtime_error("Unsupported format (rgba/rgb/bgr/bgra only)");
      }

      // Convert to BGR CV_8UC3
      cv::Mat bgr;
      if (format_ == "rgba" && src.type() == CV_8UC4) {
        cv::cvtColor(src, bgr, cv::COLOR_RGBA2BGR);
      } else if (format_ == "rgb" && src.type() == CV_8UC3) {
        cv::cvtColor(src, bgr, cv::COLOR_RGB2BGR);
      } else if (format_ == "bgr" && src.type() == CV_8UC3) {
        bgr = src.clone();
      } else if (format_ == "bgra" && src.type() == CV_8UC4) {
        cv::cvtColor(src, bgr, cv::COLOR_BGRA2BGR);
      } else {
        throw std::runtime_error("Unexpected Mat type during color conversion");
      }
      if (!bgr.isContinuous()) bgr = bgr.clone();

      const int w = bgr.cols;
      const int h = bgr.rows;
      const int step = w * 3;  // packed BGR

      // 0x9000 result buffer required by libfacedetection
      std::vector<uint8_t> result(0x9000);
      int* p = facedetect_cnn(result.data(), bgr.data, w, h, step);

      dets_.clear();
      if (p && p[0] > 0) {
        const int n = p[0];
        const short* pdata = reinterpret_cast<const short*>(result.data() + 4);
        dets_.reserve(n);
        for (int i = 0; i < n; ++i) {
          const short* r = pdata + 16 * i;
          Detection d{};
          d.score = r[0] / 100.0f;
          d.x = r[1]; d.y = r[2]; d.w = r[3]; d.h = r[4];
          for (int k = 0; k < 10; ++k) d.lm[k] = r[5 + k];
          dets_.push_back(d);
        }
      }

    } catch (const std::exception& ex) {
      SetError(ex.what());
    } catch (...) {
      SetError("Unknown error in Execute()");
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array out = Napi::Array::New(env, dets_.size());
    for (size_t i = 0; i < dets_.size(); ++i) {
      const auto& d = dets_[i];
      Napi::Object o = Napi::Object::New(env);
      o.Set("score", d.score);
      Napi::Object box = Napi::Object::New(env);
      box.Set("x", d.x);
      box.Set("y", d.y);
      box.Set("w", d.w);
      box.Set("h", d.h);
      o.Set("box", box);
      Napi::Array lm = Napi::Array::New(env, 10);
      for (int k = 0; k < 10; ++k)
        lm.Set(k, Napi::Number::New(env, d.lm[k]));
      o.Set("landmarks", lm);
      out.Set(i, o);
    }
    deferred_.Resolve(out);
    bufRef_.Reset();
    rgba_.clear(); rgba_.shrink_to_fit();
  }

  void OnError(const Napi::Error& e) override {
    deferred_.Reject(e.Value());
    bufRef_.Reset();
    rgba_.clear(); rgba_.shrink_to_fit();
  }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

private:
  Napi::Promise::Deferred deferred_;
  Napi::Reference<Napi::Buffer<uint8_t>> bufRef_;

  std::vector<uint8_t> rgba_;
  int width_{0}, height_{0}, stride_{0};
  std::string format_;
  std::vector<Detection> dets_;
};

// JS: detectAndRecognizeAsync(buffer, width, height, stride, format)
Napi::Value DetectAndRecognizeAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5 ||
      !info[0].IsBuffer() || !info[1].IsNumber() || !info[2].IsNumber() ||
      !info[3].IsNumber() || !info[4].IsString()) {
    Napi::TypeError::New(env,
      "Usage: detectAndRecognizeAsync(buffer, width, height, stride, format)"
    ).ThrowAsJavaScriptException();
    return env.Null();
  }

  auto buf    = info[0].As<Napi::Buffer<uint8_t>>();
  int width   = info[1].As<Napi::Number>().Int32Value();
  int height  = info[2].As<Napi::Number>().Int32Value();
  int stride  = info[3].As<Napi::Number>().Int32Value();
  std::string format = info[4].As<Napi::String>().Utf8Value();

  auto* worker = new DetectWorker(env, buf, width, height, stride, format);
  auto promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

} // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("detectAndRecognizeAsync",
              Napi::Function::New(env, DetectAndRecognizeAsync));
  return exports;
}

NODE_API_MODULE(faceaddon, Init)
