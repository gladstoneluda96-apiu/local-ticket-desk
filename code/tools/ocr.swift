// 工单记录小工具 · macOS 原生 OCR
// 基于系统 Vision 框架（与「实况文本」同源），完全离线，中文识别质量高。
// 用法：ocr [-fast] [--lang zh-Hans,en-US] <图片路径> [更多图片...]
// 输出：JSON { ok, text, lines: [{ text, confidence }], ms, error }

import AppKit
import Foundation
import Vision

struct Line: Codable {
    let text: String
    let confidence: Double
}

struct Output: Codable {
    let ok: Bool
    let text: String
    let lines: [Line]
    let ms: Int
    let error: String?
}

func emit(_ output: Output, code: Int32) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(output) {
        FileHandle.standardOutput.write(data)
    }
    exit(code)
}

var paths: [String] = []
var languages = ["zh-Hans", "zh-Hant", "en-US"]
var useFast = false

var args = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < args.count {
    let arg = args[index]
    switch arg {
    case "--fast":
        useFast = true
    case "--lang":
        if index + 1 < args.count {
            languages = args[index + 1].split(separator: ",").map { String($0) }
            index += 1
        }
    default:
        paths.append(arg)
    }
    index += 1
}

if paths.isEmpty {
    emit(Output(ok: false, text: "", lines: [], ms: 0, error: "缺少图片路径"), code: 1)
}

let startedAt = Date()
var allLines: [Line] = []
var errors: [String] = []

func recognize(cgImage: CGImage, languages: [String], fast: Bool) throws -> [VNRecognizedTextObservation] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = fast ? .fast : .accurate
    request.usesLanguageCorrection = true
    // 只保留系统实际支持的语言，避免不支持的语言导致整个请求失败
    if let supported = try? request.supportedRecognitionLanguages() {
        let usable = languages.filter { supported.contains($0) }
        if !usable.isEmpty {
            request.recognitionLanguages = usable
        }
    }
    if #available(macOS 13.0, *) {
        request.automaticallyDetectsLanguage = false
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    return request.results ?? []
}

for path in paths {
    guard let image = NSImage(contentsOfFile: path),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        errors.append("无法读取图片：\(path)")
        continue
    }

    var observations: [VNRecognizedTextObservation] = []
    do {
        observations = try recognize(cgImage: cgImage, languages: languages, fast: useFast)
    } catch {
        errors.append("首次识别失败：\(error.localizedDescription)")
    }

    // 指定语言识别为空时，退回系统默认语言再试一次
    if observations.isEmpty {
        do {
            let fallback = try recognize(cgImage: cgImage, languages: [], fast: useFast)
            if !fallback.isEmpty {
                observations = fallback
                errors.append("已回退到系统默认语言识别")
            }
        } catch {
            errors.append("回退识别失败：\(error.localizedDescription)")
        }
    }

    let ordered = observations.sorted { a, b in
        // 按阅读顺序排列：先上后下，同一行内先左后右
        if abs(a.boundingBox.midY - b.boundingBox.midY) > 0.02 {
            return a.boundingBox.midY > b.boundingBox.midY
        }
        return a.boundingBox.minX < b.boundingBox.minX
    }

    for observation in ordered {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        allLines.append(Line(text: text, confidence: Double(candidate.confidence)))
    }
}

let merged = allLines.map { $0.text }.joined(separator: "\n")
let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
emit(
    Output(ok: true, text: merged, lines: allLines, ms: elapsed, error: errors.isEmpty ? nil : errors.joined(separator: "；")),
    code: 0
)
