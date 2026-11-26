import Foundation
import Vision
import AppKit
guard CommandLine.arguments.count == 2, let image = NSImage(contentsOfFile: CommandLine.arguments[1]), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try VNImageRequestHandler(cgImage: cg).perform([request])
for line in request.results ?? [] { if let value = line.topCandidates(1).first { print(value.string) } }
