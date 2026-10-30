// OpenCV's headers must come before any Apple header (they clash over the NO macro).
#import <opencv2/opencv.hpp>
#import <opencv2/objdetect/aruco_detector.hpp>
#import "TagBridge.h"

@implementation GrayImage
@end

@implementation TagBridge {
    cv::aruco::ArucoDetector *_det;
}

- (instancetype)init {
    if ((self = [super init])) {
        cv::aruco::DetectorParameters params;
        params.cornerRefinementMethod = cv::aruco::CORNER_REFINE_SUBPIX;
        _det = new cv::aruco::ArucoDetector(cv::aruco::getPredefinedDictionary(cv::aruco::DICT_APRILTAG_36h11), params);
    }
    return self;
}

- (void)dealloc {
    delete _det;
}

+ (GrayImage *)uprightGray:(CVPixelBufferRef)pb {
    if (CVPixelBufferGetPlaneCount(pb) < 1) return nil;
    if (CVPixelBufferLockBaseAddress(pb, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) return nil;
    GrayImage *out = nil;
    void *base = CVPixelBufferGetBaseAddressOfPlane(pb, 0);
    if (base) {
        int w = (int)CVPixelBufferGetWidthOfPlane(pb, 0);
        int h = (int)CVPixelBufferGetHeightOfPlane(pb, 0);
        size_t stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0);
        cv::Mat src(h, w, CV_8UC1, base, stride);
        cv::Mat dst;
        cv::rotate(src, dst, cv::ROTATE_90_CLOCKWISE);
        out = [GrayImage new];
        out.data = [NSData dataWithBytes:dst.data length:dst.total()];
        out.width = dst.cols;
        out.height = dst.rows;
    }
    CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    return out;
}

- (NSArray<NSDictionary *> *)detectAprilTags:(GrayImage *)image {
    cv::Mat gray(image.height, image.width, CV_8UC1, (void *)image.data.bytes);
    std::vector<std::vector<cv::Point2f>> corners;
    std::vector<int> ids;
    _det->detectMarkers(gray, corners, ids);
    NSMutableArray *out = [NSMutableArray array];
    for (size_t i = 0; i < ids.size(); i++) {
        NSMutableArray *c = [NSMutableArray arrayWithCapacity:8];
        for (int j = 0; j < 4; j++) {
            [c addObject:@(corners[i][j].x)];
            [c addObject:@(corners[i][j].y)];
        }
        [out addObject:@{@"id": @(ids[i]), @"c": c}];
    }
    return out;
}

+ (NSDictionary *)solveSquare:(NSArray<NSNumber *> *)c size:(double)size fx:(double)fx fy:(double)fy cx:(double)cx cy:(double)cy {
    if (c.count < 8) return nil;
    double h = size / 2;
    std::vector<cv::Point3f> obj = {
        cv::Point3f(-h, h, 0), cv::Point3f(h, h, 0), cv::Point3f(h, -h, 0), cv::Point3f(-h, -h, 0)};
    std::vector<cv::Point2f> img;
    for (int j = 0; j < 4; j++) img.push_back(cv::Point2f(c[2 * j].doubleValue, c[2 * j + 1].doubleValue));
    cv::Mat k = (cv::Mat_<double>(3, 3) << fx, 0, cx, 0, fy, cy, 0, 0, 1);
    cv::Mat rvec, tvec;
    bool ok = cv::solvePnP(obj, img, k, cv::Mat(), rvec, tvec, false, cv::SOLVEPNP_IPPE_SQUARE);
    if (!ok) return nil;
    return @{
        @"p": @[@(tvec.at<double>(0)), @(tvec.at<double>(1)), @(tvec.at<double>(2))],
        @"r": @[@(rvec.at<double>(0)), @(rvec.at<double>(1)), @(rvec.at<double>(2))],
    };
}

@end
