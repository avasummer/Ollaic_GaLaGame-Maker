//! 背景抠除（matting）：使用本地 ONNX 模型 isnet-anime（Apache-2.0，动漫角色专用）
//! 为 AI 生成的立绘去除背景，输出带 alpha 通道的透明 PNG。
//!
//! 预处理 / 后处理规格对齐 rembg 的 isnet-anime 实现：
//! - 输入：转 RGB → resize 1024×1024（Lanczos）→ 除以整图最大像素值 → 逐通道
//!   (c - mean)/std，mean=(0.485,0.456,0.406)、std=(1,1,1) → NCHW float32。
//! - 输出：单通道 mask → min-max 归一化到 0..1 → 作为 alpha → 缩放回原尺寸（Lanczos）。

use crate::ai::commands::GeneratedMedia;
use base64::Engine;
use image::imageops::FilterType;
use image::{GrayImage, RgbaImage};
use ndarray::Array4;
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// 模型输入尺寸（isnet 推荐 1024）。
const MODEL_SIZE: usize = 1024;
/// 预处理逐通道均值（RGB 顺序）。
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// 预处理逐通道标准差（isnet-anime 全为 1.0，即仅做减均值）。
const STD: [f32; 3] = [1.0, 1.0, 1.0];

/// 全局缓存的推理会话。模型约 168MB，加载昂贵，故进程内只加载一次。
/// `Session::run` 需要 `&mut self`，因此用 `Mutex` 串行化推理调用。
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// 定位内置的 isnet-anime.onnx 模型文件，沿用与 WebGAL 模板一致的查找顺序：
/// 1) 环境变量覆盖（开发/自定义）；2) 打包资源目录；3) 源码树（dev 构建）。
fn resolve_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("MATTING_MODEL_PATH") {
        let candidate = PathBuf::from(p);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("models/isnet-anime.onnx");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models/isnet-anime.onnx");
    if dev_path.is_file() {
        return Ok(dev_path);
    }
    Err("未找到抠图模型 isnet-anime.onnx，请确认随安装包内置或设置 MATTING_MODEL_PATH。".to_string())
}

/// 去除立绘背景。输入为（可能带 data URL 前缀的）base64 图像，输出透明 PNG 的 base64。
#[tauri::command]
pub async fn remove_background(
    app: AppHandle,
    base64_data: String,
) -> Result<GeneratedMedia, String> {
    // ONNX 推理是 CPU 密集型的同步工作，放到阻塞线程池，避免卡住异步运行时。
    tauri::async_runtime::spawn_blocking(move || {
        let model_path = resolve_model_path(&app)?;
        let encoded = base64_data
            .split_once(',')
            .map(|(_, payload)| payload)
            .unwrap_or(&base64_data);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|e| format!("解析待抠图图像失败: {e}"))?;

        let png_bytes = matte_image(&model_path, &bytes)?;
        Ok(GeneratedMedia {
            base64_data: base64::engine::general_purpose::STANDARD.encode(&png_bytes),
            extension: "png".to_string(),
        })
    })
    .await
    .map_err(|e| format!("抠图任务调度失败: {e}"))?
}

/// 核心抠图：输入原始图像字节，输出带 alpha 的透明 PNG 字节。
/// 与 `AppHandle` 解耦，便于直接测试。
fn matte_image(model_path: &Path, image_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let dynamic =
        image::load_from_memory(image_bytes).map_err(|e| format!("解码待抠图图像失败: {e}"))?;
    let rgba = dynamic.to_rgba8();
    let (orig_w, orig_h) = (rgba.width(), rgba.height());

    let input = preprocess(&dynamic);
    let mask = run_inference(model_path, input)?;

    // mask 为 1024×1024 灰度，缩放回原始尺寸后作为 alpha 通道。
    let mask_img = GrayImage::from_raw(MODEL_SIZE as u32, MODEL_SIZE as u32, mask)
        .ok_or_else(|| "构建 mask 图像失败".to_string())?;
    let mask_resized = image::imageops::resize(&mask_img, orig_w, orig_h, FilterType::Lanczos3);

    let mut out = RgbaImage::new(orig_w, orig_h);
    for (x, y, pixel) in out.enumerate_pixels_mut() {
        let src = rgba.get_pixel(x, y);
        let alpha = mask_resized.get_pixel(x, y)[0];
        *pixel = image::Rgba([src[0], src[1], src[2], alpha]);
    }

    let mut png_bytes: Vec<u8> = Vec::new();
    out.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("编码透明 PNG 失败: {e}"))?;
    Ok(png_bytes)
}

/// 预处理为 NCHW float32 张量（1,3,1024,1024），通道顺序 RGB。
fn preprocess(dynamic: &image::DynamicImage) -> Array4<f32> {
    let resized = dynamic
        .resize_exact(MODEL_SIZE as u32, MODEL_SIZE as u32, FilterType::Lanczos3)
        .to_rgb8();

    // 除以整图最大像素值（对 8-bit 图等价于 /255，并避免除零）。
    let max_pixel = resized.iter().copied().max().unwrap_or(0).max(1) as f32;

    let mut input = Array4::<f32>::zeros((1, 3, MODEL_SIZE, MODEL_SIZE));
    for (x, y, pixel) in resized.enumerate_pixels() {
        let (xi, yi) = (x as usize, y as usize);
        for c in 0..3 {
            let v = pixel[c] as f32 / max_pixel;
            input[[0, c, yi, xi]] = (v - MEAN[c]) / STD[c];
        }
    }
    input
}

/// 运行 ONNX 推理，返回 1024×1024 的 8-bit alpha mask（已 min-max 归一化）。
fn run_inference(model_path: &Path, input: Array4<f32>) -> Result<Vec<u8>, String> {
    let mut guard = SESSION.lock().map_err(|_| "抠图会话锁中毒".to_string())?;
    if guard.is_none() {
        let session = Session::builder()
            .map_err(|e| format!("创建抠图会话失败: {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("加载抠图模型失败 {}: {e}", model_path.display()))?;
        *guard = Some(session);
    }
    let session = guard.as_mut().expect("session 已初始化");

    let tensor = Tensor::from_array(input).map_err(|e| format!("构建输入张量失败: {e}"))?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|e| format!("抠图推理失败: {e}"))?;

    let (_shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("读取抠图输出失败: {e}"))?;

    if data.len() != MODEL_SIZE * MODEL_SIZE {
        return Err(format!(
            "抠图输出尺寸异常：期望 {} 个像素，实际 {}",
            MODEL_SIZE * MODEL_SIZE,
            data.len()
        ));
    }

    // isnet 输出未归一化的显著性分数，做 min-max 归一化到 0..1 再转 8-bit alpha。
    let (mut mi, mut ma) = (f32::INFINITY, f32::NEG_INFINITY);
    for &v in data {
        if v < mi {
            mi = v;
        }
        if v > ma {
            ma = v;
        }
    }
    let range = (ma - mi).max(1e-6);
    let mask: Vec<u8> = data
        .iter()
        .map(|&v| (((v - mi) / range) * 255.0).round().clamp(0.0, 255.0) as u8)
        .collect();
    Ok(mask)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 冒烟测试：用内置模型抠一张合成图（白底 + 居中红色实心方块），
    /// 验证输出是合法的 RGBA PNG、尺寸不变，且前景（方块）比背景（四角）更不透明。
    /// 需要本地存在模型文件；缺失时跳过（CI 无模型时不算失败）。
    #[test]
    fn matte_image_produces_transparent_png() {
        let model_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models/isnet-anime.onnx");
        if !model_path.is_file() {
            eprintln!("跳过：未找到模型 {}", model_path.display());
            return;
        }

        // 合成 256×256 白底，中心 96×96 红色方块作为“前景主体”。
        let mut img = RgbaImage::from_pixel(256, 256, image::Rgba([255, 255, 255, 255]));
        for y in 80..176 {
            for x in 80..176 {
                img.put_pixel(x, y, image::Rgba([220, 30, 30, 255]));
            }
        }
        let mut src_png: Vec<u8> = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut src_png), image::ImageFormat::Png)
            .unwrap();

        let out_png = matte_image(&model_path, &src_png).expect("抠图应成功");
        let out = image::load_from_memory(&out_png).expect("输出应为合法图像");
        let out = out.to_rgba8();
        assert_eq!(out.dimensions(), (256, 256), "尺寸应保持不变");

        let center_alpha = out.get_pixel(128, 128)[3] as u32;
        let corner_alpha = out.get_pixel(2, 2)[3] as u32;
        assert!(
            center_alpha > corner_alpha,
            "前景应比背景更不透明：center={center_alpha} corner={corner_alpha}"
        );
    }
}
