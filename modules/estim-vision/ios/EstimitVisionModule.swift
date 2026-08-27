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

    guard let url = URL(string: uri), let sourceImage = UIImage(contentsOfFile: url.path) else {
      throw VisionError.invalidImage
    }
    // Camera files often store portrait orientation as EXIF metadata while their raw pixels
    // remain landscape. Vision and Core Image need a single upright raster to keep the mask
    // and React Native preview aligned.
    let image = normalized(sourceImage)
    guard let cgImage = image.cgImage else { throw VisionError.invalidImage }

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

    // A simple multiply darkens the background without altering its contrast or color balance.
    let dimmed = original.applyingFilter("CIColorMatrix", parameters: [
      kCIInputRVectorKey: CIVector(x: 0.32, y: 0, z: 0, w: 0),
      kCIInputGVectorKey: CIVector(x: 0, y: 0.32, z: 0, w: 0),
      kCIInputBVectorKey: CIVector(x: 0, y: 0, z: 0.32, w: 0),
      kCIInputAVectorKey: CIVector(x: 0, y: 0, z: 0, w: 1),
    ])

    // Expanding the mask leaves a precise colored edge after the untouched object is composited back.
    let expandedMask = mask.applyingFilter("CIMorphologyMaximum", parameters: ["inputRadius": 7.0])
    let greenGradient = gradient(in: original.extent)
    let basePreview = blend(foreground: original, over: dimmed, using: mask)
    var previewURLs = [try write(basePreview, extent: original.extent)]

    // Reveal the true object edge from one point around the subject, rather than fading an
    // entire generic border in at once. Each sector is intersected with the real mask.
    for step in 1...7 {
      let sector = angularRevealMask(in: original.extent, progress: CGFloat(step) / 7)
      let partialOutlineMask = expandedMask.applyingFilter("CIMultiplyCompositing", parameters: [
        kCIInputBackgroundImageKey: sector,
      ])
      let outlined = blend(foreground: greenGradient, over: dimmed, using: partialOutlineMask)
      let frame = blend(foreground: original, over: outlined, using: mask)
      previewURLs.append(try write(frame, extent: original.extent))
    }
    return previewURLs.joined(separator: "|")
  }

  private func scaledMask(_ mask: CIImage, to extent: CGRect) -> CIImage {
    let scaleX = extent.width / mask.extent.width
    let scaleY = extent.height / mask.extent.height
    return mask.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
  }

  private func normalized(_ image: UIImage) -> UIImage {
    guard image.imageOrientation != .up else { return image }
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
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

  private func angularRevealMask(in extent: CGRect, progress: CGFloat) -> CIImage {
    let size = extent.size
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    let wedge = UIGraphicsImageRenderer(size: size, format: format).image { renderer in
      UIColor.black.setFill()
      renderer.cgContext.fill(CGRect(origin: .zero, size: size))
      UIColor.white.setFill()
      let center = CGPoint(x: size.width / 2, y: size.height / 2)
      let radius = hypot(size.width, size.height)
      let path = UIBezierPath()
      path.move(to: center)
      path.addArc(withCenter: center, radius: radius, startAngle: -.pi / 2, endAngle: -.pi / 2 + (.pi * 2 * progress), clockwise: true)
      path.close()
      path.fill()
    }
    return CIImage(cgImage: wedge.cgImage!).cropped(to: extent)
  }

  private func write(_ image: CIImage, extent: CGRect) throws -> String {
    guard let output = context.createCGImage(image, from: extent) else { throw VisionError.renderFailed }
    let outputURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("estimit-scan-\(UUID().uuidString).png")
    guard let png = UIImage(cgImage: output).pngData() else { throw VisionError.renderFailed }
    try png.write(to: outputURL, options: .atomic)
    return outputURL.absoluteString
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
