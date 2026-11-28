// macOS filters at the HID element level. This callback receives only the physical
// right-bracket switch, including its release. No text or key codes go to JS.
#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <IOKit/hid/IOHIDManager.h>
#import <IOKit/hidsystem/IOHIDLib.h>
#include <node_api.h>

static IOHIDManagerRef manager;
static napi_threadsafe_function summon;
static unsigned taps;
static uint32_t previousCount;
static CFTimeInterval firstTap, pressedAt;
static void deliver(napi_env env, napi_value callback, void *, void *data) {
  NSString *bundle = CFBridgingRelease(data);
  if (!env) return;
  napi_value source, value, receiver;
  napi_create_object(env, &source);
  napi_create_string_utf8(env, bundle.UTF8String ?: "", NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, source, "bundleId", value);
  napi_get_undefined(env, &receiver);
  napi_call_function(env, receiver, callback, 1, &source, nullptr);
}

static void bracket(void *, IOReturn result, void *, IOHIDValueRef value) {
  if (result != kIOReturnSuccess || !summon) return;
  IOHIDElementRef element = IOHIDValueGetElement(value);
  if (IOHIDElementGetUsagePage(element) != kHIDPage_KeyboardOrKeypad ||
      IOHIDElementGetUsage(element) != kHIDUsage_KeyboardCloseBracket) return;
  if (NSApp.isActive || IsSecureEventInputEnabled()) { pressedAt = 0; taps = 0; return; }
  const auto flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
  if (flags & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift)) {
    pressedAt = 0; taps = 0; return;
  }
  const double now = NSProcessInfo.processInfo.systemUptime;
  if (IOHIDValueGetIntegerValue(value)) {
    if (!pressedAt) pressedAt = now;
    return;
  }
  if (!pressedAt || now - pressedAt > .55) { taps = 0; pressedAt = 0; return; }
  pressedAt = 0;
  // An aggregate counter tells us if another key intervened, without receiving it.
  const uint32_t count = CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventKeyDown);
  if (!taps || now - firstTap > .85 || count - previousCount != 1) { taps = 0; firstTap = now; }
  previousCount = count;
  if (++taps == 3) {
    taps = 0;
    void *bundle = (void *)CFBridgingRetain(NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier ?: @"");
    if (napi_call_threadsafe_function(summon, bundle, napi_tsfn_nonblocking) != napi_ok) CFBridgingRelease(bundle);
  }
}
static void stop(void *) {
  if (manager) {
    IOHIDManagerUnscheduleFromRunLoop(manager, CFRunLoopGetMain(), kCFRunLoopCommonModes);
    IOHIDManagerClose(manager, kIOHIDOptionsTypeNone);
    CFRelease(manager);
    manager = nullptr;
  }
  if (summon) { napi_release_threadsafe_function(summon, napi_tsfn_abort); summon = nullptr; }
  taps = 0; pressedAt = 0;
}
static napi_value boolean(napi_env env, bool ok) {
  napi_value value; napi_get_boolean(env, ok, &value); return value;
}
static napi_value request(napi_env env, napi_callback_info) {
  return boolean(env, IOHIDRequestAccess(kIOHIDRequestTypeListenEvent));
}
static napi_value start(napi_env env, napi_callback_info info) {
  if (manager) return boolean(env, true);
  if (IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted) return boolean(env, false);
  size_t argc = 1; napi_value callback, name; napi_valuetype type;
  napi_get_cb_info(env, info, &argc, &callback, nullptr, nullptr);
  if (argc != 1 || napi_typeof(env, callback, &type) != napi_ok || type != napi_function) return boolean(env, false);
  napi_create_string_utf8(env, "Enki bracket shortcut", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, callback, nullptr, name, 1, 1, nullptr, nullptr,
      nullptr, deliver, &summon) != napi_ok) return boolean(env, false);
  manager = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
  if (!manager) { stop(nullptr); return boolean(env, false); }
  NSDictionary *keyboards = @{@kIOHIDDeviceUsagePageKey: @(kHIDPage_GenericDesktop),
                               @kIOHIDDeviceUsageKey: @(kHIDUsage_GD_Keyboard)};
  NSDictionary *rightBracket = @{@kIOHIDElementUsagePageKey: @(kHIDPage_KeyboardOrKeypad),
                                  @kIOHIDElementUsageKey: @(kHIDUsage_KeyboardCloseBracket)};
  IOHIDManagerSetDeviceMatching(manager, (__bridge CFDictionaryRef)keyboards);
  IOHIDManagerSetInputValueMatching(manager, (__bridge CFDictionaryRef)rightBracket);
  IOHIDManagerRegisterInputValueCallback(manager, bracket, nullptr);
  IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), kCFRunLoopCommonModes);
  if (IOHIDManagerOpen(manager, kIOHIDOptionsTypeNone) != kIOReturnSuccess) { stop(nullptr); return boolean(env, false); }
  napi_unref_threadsafe_function(env, summon);
  return boolean(env, true);
}
static napi_value disable(napi_env env, napi_callback_info) { stop(nullptr); return boolean(env, true); }
NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
    {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, disable, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"request", nullptr, request, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 3, methods);
  napi_add_env_cleanup_hook(env, stop, nullptr);
  return exports;
}
