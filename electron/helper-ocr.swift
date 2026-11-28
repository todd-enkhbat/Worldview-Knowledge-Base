import Foundation
import Vision
import AppKit
import PDFKit

func recognize(_ image: NSImage) throws -> String {
    guard let bitmap = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw CocoaError(.fileReadCorruptFile)
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    try VNImageRequestHandler(cgImage: bitmap).perform([request])
    return (request.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

struct ScreenLine: Encodable {
    let text: String
    let x: Double
    let y: Double
    let height: Double
}

func readScreen() throws -> Data {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 16 * 1024 * 1024, let image = NSImage(data: data),
          let bitmap = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw CocoaError(.fileReadCorruptFile)
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    try VNImageRequestHandler(cgImage: bitmap).perform([request])
    let lines = (request.results ?? []).prefix(300).compactMap { observation -> ScreenLine? in
        guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.45 else { return nil }
        let bounds = observation.boundingBox
        return ScreenLine(text: String(candidate.string.prefix(250)), x: bounds.minX, y: 1 - bounds.maxY, height: bounds.height)
    }
    return try JSONEncoder().encode(lines)
}

func readPDF(_ url: URL) throws -> String {
    guard let document = PDFDocument(url: url), !document.isLocked, document.pageCount > 0 else {
        throw CocoaError(.fileReadCorruptFile)
    }
    guard document.pageCount <= 100 else {
        throw CocoaError(.fileReadTooLarge)
    }
    var scannedPages = 0
    var pages: [String] = []
    for index in 0..<document.pageCount {
        let text = try autoreleasepool {
            guard let page = document.page(at: index) else { throw CocoaError(.fileReadCorruptFile) }
            if let retainedText = page.string, !retainedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return retainedText
            }
            scannedPages += 1
            guard scannedPages <= 50 else { throw CocoaError(.fileReadTooLarge) }
            let bounds = page.bounds(for: .cropBox)
            guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0 else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let scale = 2200 / max(bounds.width, bounds.height)
            let size = NSSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
            return try recognize(page.thumbnail(of: size, for: .cropBox))
        }
        pages.append(text.replacingOccurrences(of: "\u{000C}", with: "\n"))
    }
    return pages.joined(separator: "\u{000C}") + "\u{000C}"
}

let args = Array(CommandLine.arguments.dropFirst())
do {
    if args == ["--screen-lines"] {
        FileHandle.standardOutput.write(try readScreen())
    } else if args.count == 2, args[0] == "--pdf" {
        let text = try readPDF(URL(fileURLWithPath: args[1]))
        FileHandle.standardOutput.write(Data(text.utf8))
    } else if args.count == 1, let image = NSImage(contentsOfFile: args[0]) {
        print(try recognize(image))
    } else {
        exit(1)
    }
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
