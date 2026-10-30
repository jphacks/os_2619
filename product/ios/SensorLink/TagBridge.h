#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>

NS_ASSUME_NONNULL_BEGIN

/// An upright 8-bit grey picture.
@interface GrayImage : NSObject
@property (nonatomic, strong) NSData *data;
@property (nonatomic) int width;
@property (nonatomic) int height;
@end

/// The OpenCV part of the tag detection (Vision.kt): AprilTag tag36h11 through the aruco module, and solvePnP.
/// Kept in Objective-C++ because OpenCV has no Swift API; this header stays free of C++ so Swift can import it.
@interface TagBridge : NSObject

/// The luma plane of a camera frame, rotated 90° clockwise. The sensor is landscape; this is the upright portrait picture.
+ (nullable GrayImage *)uprightGray:(CVPixelBufferRef)pixelBuffer;

/// AprilTag 36h11. Each result is @{@"id": NSNumber, @"c": @[x0, y0, x1, y1, x2, y2, x3, y3]} in OpenCV corner order.
- (NSArray<NSDictionary *> *)detectAprilTags:(GrayImage *)image;

/// Pose of a square tag of side `size` metres from its 4 corners (same order as above), by IPPE_SQUARE.
/// Returns @{@"p": @[x, y, z], @"r": @[rx, ry, rz]} (OpenCV camera frame: x right, y down, z forward), or nil.
+ (nullable NSDictionary *)solveSquare:(NSArray<NSNumber *> *)corners size:(double)size fx:(double)fx fy:(double)fy cx:(double)cx cy:(double)cy;

@end

NS_ASSUME_NONNULL_END
