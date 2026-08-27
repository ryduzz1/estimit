import CoreImage
import ExpoModulesCore
import UIKit
import Vision

public class EstimitVisionModule: Module {
  private let context = CIContext(options: [.cacheIntermediates: false])

  public func definition() -> ModuleDefinition {
    Name("EstimitVision")

    AsyncFunction("processImageAsync") { (uri: String) throws -> String in
      return try self.makeScanningPreview(from: uri)
    }
    .runOnQueue(.global(qos: .userInitiated))
  }

  private func makeScanningPreview(from uri: String) throws -> String {
    guard #available(iOS 17.0, *) else {
      throw VisionError.unsupportedOS
    }

    guard let url = URL(string: uri), let image = UIImage(contentsOfFile: url.path), let cgImage = image.cgImage else {
      throw VisionError.invalidImage
    }

    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up)
    try handler.perform([request])

    guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
      throw VisionError.noForegroundObject
    }

    let maskBuffer = try observation.generateScaledMaskForImage(
      forInstances: observation.allInstances,
      from: handler
    )
    let original = CIImage(cgImage: cgImage)
    let mask = scaledMask(CIImage(cvPixelBuffer: maskBuffer), to: original.extent)

    let dimmed = original.applyingFilter("CIColorControls", parameters: [
      kCIInputBrightnessKey: -0.42,
      kCIInputContrastKey: 0.92,
      kCIInputSaturationKey: 0.55,
    ])

    // Expanding the mask leaves a precise colored edge after the untouched object is composited back.
    let expandedMask = mask.applyingFilter("CIMorphologyMaximum", parameters: ["inputRadius": 7.0])
    let greenGradient = gradient(in: original.extent)
    let outlined = blend(foreground: greenGradient, over: dimmed, using: expandedMask)
    let result = blend(foreground: original, over: outlined, using: mask)

    guard let output = context.createCGImage(result, from: original.extent) else {
      throw VisionError.renderFailed
    }

    let outputURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("estimit-scan-\(UUID().uuidString).png")
    guard let png = UIImage(cgImage: output).pngData() else {
      throw VisionError.renderFailed
    }
    try png.write(to: outputURL, options: .atomic)
    return outputURL.absoluteString
  }

  private func scaledMask(_ mask: CIImage, to extent: CGRect) -> CIImage {
    let scaleX = extent.width / mask.extent.width
    let scaleY = extent.height / mask.extent.height
    return mask.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
  }

  private func gradient(in extent: CGRect) -> CIImage {
    let filter = CIFilter(name: "CILinearGradient", parameters: [
      "inputPoint0": CIVector(x: extent.minX, y: extent.maxY),
      "inputPoint1": CIVector(x: extent.maxX, y: extent.minY),
      "inputColor0": CIColor(red: 0.24, green: 0.67, blue: 0.36),
      "inputColor1": CIColor(red: 0.64, green: 0.95, blue: 0.62),
    ])!
    return filter.outputImage!.cropped(to: extent)
  }

  private func blend(foreground: CIImage, over background: CIImage, using mask: CIImage) -> CIImage {
    return foreground.applyingFilter("CIBlendWithMask", parameters: [
      kCIInputBackgroundImageKey: background,
      kCIInputMaskImageKey: mask,
    ])
  }
}

private enum VisionError: LocalizedError {
  case unsupportedOS
  case invalidImage
  case noForegroundObject
  case renderFailed

  var errorDescription: String? {
    switch self {
    case .unsupportedOS: return "Object masking requires iOS 17 or later."
    case .invalidImage: return "The captured image could not be read."
    case .noForegroundObject: return "No clear foreground object was detected."
    case .renderFailed: return "The scanning preview could not be rendered."
    }
  }
}
