#import <AppKit/AppKit.h>
#import <CoreLocation/CoreLocation.h>
#import <Photos/Photos.h>
#import <Contacts/Contacts.h>
#import <Vision/Vision.h>
#include <node_api.h>
#include <string>

// Runs inside the signed Worldview main process. PhotoKit owns authorization,
// library access and resource selection. No files, database paths or Apple IDs
// cross the bridge, and the image request never downloads an iCloud original.
static PHFetchResult<PHAsset *> *snapshot;
static PHAuthorizationStatus snapshotAccess;

static PHAuthorizationStatus accessStatus() {
  return [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite];
}
static bool permitted(PHAuthorizationStatus status) {
  return status == PHAuthorizationStatusAuthorized || status == PHAuthorizationStatusLimited;
}
static NSString *accessError() {
  return @"Photos access is off. Allow Worldview in System Settings → Privacy & Security → Photos, then connect again.";
}
static NSString *authorize(bool request) {
  if (accessStatus() == PHAuthorizationStatusNotDetermined && request) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_main_queue(), ^{
      [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelReadWrite handler:^(PHAuthorizationStatus status) {
        dispatch_semaphore_signal(done);
      }];
    });
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 180 * NSEC_PER_SEC))) return @"The Photos permission request timed out. Try connecting again.";
  }
  if (!permitted(accessStatus())) { snapshot = nil; return accessError(); }
  return nil;
}

// PhotoKit returns nil when this rendition is not on the Mac. Each caller
// releases the retained CGImage before moving to the next asset.
static CGImageRef copyLocalPreview(PHAsset *asset) {
  PHImageRequestOptions *options = [PHImageRequestOptions new];
  options.synchronous = YES;
  options.networkAccessAllowed = NO;
  options.deliveryMode = PHImageRequestOptionsDeliveryModeFastFormat;
  options.resizeMode = PHImageRequestOptionsResizeModeExact;
  __block CGImageRef preview = NULL;
  [[PHImageManager defaultManager] requestImageForAsset:asset targetSize:CGSizeMake(256, 256)
    contentMode:PHImageContentModeAspectFit options:options resultHandler:^(NSImage *image, NSDictionary *info) {
      if (!image || [info[PHImageCancelledKey] boolValue] || info[PHImageErrorKey]) return;
      CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
      if (cg && CGImageGetWidth(cg) <= 512 && CGImageGetHeight(cg) <= 512) {
        if (preview) CGImageRelease(preview);
        preview = CGImageRetain(cg);
      }
    }];
  return preview;
}
static NSArray *classify(PHAsset *asset) {
  CGImageRef image = copyLocalPreview(asset);
  if (!image) return nil;
  VNClassifyImageRequest *request = [VNClassifyImageRequest new];
  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
  NSError *error = nil;
  bool ok = [handler performRequests:@[request] error:&error];
  CGImageRelease(image);
  if (!ok) return nil;
  NSMutableOrderedSet *subjects = [NSMutableOrderedSet orderedSet];
  for (VNClassificationObservation *label in request.results) {
    if (label.confidence >= 0.45 && label.identifier.length) {
      [subjects addObject:[label.identifier stringByReplacingOccurrencesOfString:@"_" withString:@" "]];
      if (subjects.count == 8) break;
    }
  }
  return subjects.array;
}

static id readPage(NSUInteger offset, bool ask, bool labels, NSString **error) {
  *error = authorize(!offset && ask);
  if (*error) return nil;
  PHAuthorizationStatus access = accessStatus();
  if (!offset) {
    PHFetchOptions *options = [PHFetchOptions new];
    options.includeHiddenAssets = NO;
    options.sortDescriptors = @[[NSSortDescriptor sortDescriptorWithKey:@"creationDate" ascending:NO]];
    snapshot = [PHAsset fetchAssetsWithMediaType:PHAssetMediaTypeImage options:options];
    snapshotAccess = access;
  }
  if (!snapshot || offset > snapshot.count || access != snapshotAccess) {
    snapshot = nil;
    *error = @"The Photos selection changed. Start the import again.";
    return nil;
  }
  NSUInteger total = snapshot.count, end = MIN(offset + (labels ? 16 : 500), total);
  NSMutableArray *ids = [NSMutableArray array];
  for (NSUInteger index = offset; index < end; index++) [ids addObject:[snapshot objectAtIndex:index].localIdentifier];
  // The snapshot fixes page boundaries during library edits. Re-fetch this
  // page's identifiers under current access so removed or deselected photos skip.
  PHFetchResult *visible = [PHAsset fetchAssetsWithLocalIdentifiers:ids options:nil];
  NSMutableArray *records = [NSMutableArray array];
  NSISO8601DateFormatter *format = [NSISO8601DateFormatter new];
  for (PHAsset *asset in visible) {
    CLLocation *place = asset.location;
    if (!place || asset.hidden || !CLLocationCoordinate2DIsValid(place.coordinate)) continue;
    NSString *filename = nil;
    for (PHAssetResource *resource in [PHAssetResource assetResourcesForAsset:asset]) {
      if (resource.type == PHAssetResourceTypePhoto || resource.type == PHAssetResourceTypeFullSizePhoto) {
        filename = resource.originalFilename; break;
      }
    }
    NSMutableDictionary *record = [@{@"id":asset.localIdentifier, @"latitude":@(place.coordinate.latitude),
      @"longitude":@(place.coordinate.longitude), @"title": filename.length ? filename : @"Photo"} mutableCopy];
    if (filename.length) record[@"filename"] = filename;
    if (asset.creationDate) record[@"date"] = [format stringFromDate:asset.creationDate];
    NSMutableOrderedSet *albums = [NSMutableOrderedSet orderedSet];
    for (PHAssetCollection *album in [PHAssetCollection fetchAssetCollectionsContainingAsset:asset withType:PHAssetCollectionTypeAlbum options:nil]) {
      if (album.localizedTitle.length) [albums addObject:album.localizedTitle];
    }
    record[@"keywords"] = albums.array;
    if (labels) {
      NSArray *subjects = classify(asset);
      if (subjects) record[@"visualLabels"] = subjects;
    }
    [records addObject:record];
  }
  if (access != accessStatus()) { snapshot = nil; *error = accessError(); return nil; }
  if (end == total) snapshot = nil;
  return @{@"records":records, @"nextOffset": end < total ? @(end) : [NSNull null],
           @"total":@(total), @"limited":@(access == PHAuthorizationStatusLimited)};
}

static id thumbnail(NSString *identifier, NSString **error) {
  *error = authorize(false);
  if (*error) return nil;
  PHAsset *asset = [PHAsset fetchAssetsWithLocalIdentifiers:@[identifier] options:nil].firstObject;
  if (!asset || asset.hidden || !asset.location || asset.mediaType != PHAssetMediaTypeImage) return [NSNull null];
  CGImageRef cg = copyLocalPreview(asset);
  if (!cg) return [NSNull null];
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:cg];
  CGImageRelease(cg);
  NSData *data = [rep representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor:@0.72}];
  if (!permitted(accessStatus())) { *error = accessError(); return nil; }
  if (!data.length || data.length > 180000) return [NSNull null];
  return [@"data:image/jpeg;base64," stringByAppendingString:[data base64EncodedStringWithOptions:0]];
}

static id contactNames(NSString **error) {
  CNContactStore *store = [CNContactStore new];
  if ([CNContactStore authorizationStatusForEntityType:CNEntityTypeContacts] == CNAuthorizationStatusNotDetermined) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_main_queue(), ^{
      [store requestAccessForEntityType:CNEntityTypeContacts completionHandler:^(BOOL granted, NSError *cause) {
        dispatch_semaphore_signal(done);
      }];
    });
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 180 * NSEC_PER_SEC))) {
      *error = @"The Contacts permission request timed out."; return nil;
    }
  }
  CNContactFetchRequest *request = [[CNContactFetchRequest alloc] initWithKeysToFetch:@[CNContactGivenNameKey, CNContactMiddleNameKey, CNContactFamilyNameKey]];
  NSMutableArray *names = [NSMutableArray array];
  NSError *cause = nil;
  BOOL ok = [store enumerateContactsWithFetchRequest:request error:&cause usingBlock:^(CNContact *contact, BOOL *stop) {
    if (contact.givenName.length && contact.familyName.length) {
      NSArray *parts = [@[contact.givenName,contact.middleName,contact.familyName] filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"length > 0"]];
      [names addObject:[parts componentsJoinedByString:@" "]];
    }
  }];
  if (!ok) { *error = @"Worldview could not read Contacts. Check System Settings → Privacy & Security → Contacts and try again."; return nil; }
  return names;
}

struct Request {
  napi_async_work work;
  napi_deferred result;
  bool contacts = false, photo = false, ask = false, labels = false;
  uint32_t offset = 0;
  std::string id, json, error;
};
static void execute(napi_env, void *raw) {
  Request *r = static_cast<Request *>(raw);
  @autoreleasepool {
    @try {
      NSString *error = nil;
      id value = r->contacts ? contactNames(&error) : r->photo ? thumbnail([NSString stringWithUTF8String:r->id.c_str()], &error) : readPage(r->offset, r->ask, r->labels, &error);
      if (error) { r->error = error.UTF8String; return; }
      NSData *json = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:nil];
      if (json) r->json.assign((const char *)json.bytes, json.length);
      else r->error = "Photos metadata could not be read.";
    } @catch (NSException *exception) { r->error = "Photos could not complete this read. Reopen Maps and try again."; }
  }
}
static void complete(napi_env env, napi_status status, void *raw) {
  Request *r = static_cast<Request *>(raw);
  napi_value output;
  if (status != napi_ok || !r->error.empty()) {
    napi_value message;
    napi_create_string_utf8(env, r->error.empty() ? "Photos read interrupted." : r->error.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &output);
    napi_reject_deferred(env, r->result, output);
  } else {
    napi_create_string_utf8(env, r->json.c_str(), r->json.size(), &output);
    napi_resolve_deferred(env, r->result, output);
  }
  napi_delete_async_work(env, r->work);
  delete r;
}
static napi_value read(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3], label, promise;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  napi_valuetype type;
  if (!count || napi_typeof(env, args[0], &type) != napi_ok || (type != napi_number && type != napi_string && type != napi_boolean)) {
    napi_throw_type_error(env, nullptr, "Choose an offset or a photo identifier."); return nullptr;
  }
  Request *r = new Request;
  if (type == napi_boolean) r->contacts = true;
  else if (type == napi_number) {
    napi_get_value_uint32(env, args[0], &r->offset);
    if (count > 1) napi_get_value_bool(env, args[1], &r->ask);
    if (count > 2) napi_get_value_bool(env, args[2], &r->labels);
  }
  else {
    char id[1025]; size_t length = 0;
    napi_get_value_string_utf8(env, args[0], id, sizeof(id), &length);
    if (!length || length >= sizeof(id) - 1) { delete r; napi_throw_range_error(env, nullptr, "Invalid photo identifier."); return nullptr; }
    r->photo = true;
    r->id.assign(id, length);
  }
  napi_create_string_utf8(env, "Worldview Photos", NAPI_AUTO_LENGTH, &label);
  napi_create_promise(env, &r->result, &promise);
  napi_create_async_work(env, nullptr, label, execute, complete, r, &r->work);
  napi_queue_async_work(env, r->work);
  return promise;
}
NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "read", NAPI_AUTO_LENGTH, read, nullptr, &fn);
  napi_set_named_property(env, exports, "read", fn);
  return exports;
}
