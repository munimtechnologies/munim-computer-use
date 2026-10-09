#import <Foundation/Foundation.h>
#import "VirtualDisplay.h"

// The private classes' interfaces, as far as they are used. Declared as a
// protocol so ARC sees the init family and the selectors without linking
// against symbols that may not exist.
@protocol MCUVirtualDisplayDescriptor <NSObject>
@property(copy) NSString *name;
@property unsigned int maxPixelsWide;
@property unsigned int maxPixelsHigh;
@property CGSize sizeInMillimeters;
@property unsigned int productID;
@property unsigned int vendorID;
@property unsigned int serialNum;
@property(retain) dispatch_queue_t queue;
@end

@protocol MCUVirtualDisplayMode <NSObject>
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)refreshRate;
@end

@protocol MCUVirtualDisplaySettings <NSObject>
@property unsigned int hiDPI;
@property(retain) NSArray *modes;
@end

@protocol MCUVirtualDisplay <NSObject>
- (instancetype)initWithDescriptor:(id<MCUVirtualDisplayDescriptor>)descriptor;
- (BOOL)applySettings:(id<MCUVirtualDisplaySettings>)settings;
@property(readonly) CGDirectDisplayID displayID;
@end

static NSMutableDictionary<NSNumber *, id> *liveDisplays(void) {
    static NSMutableDictionary *displays;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ displays = [NSMutableDictionary dictionary]; });
    return displays;
}

CGDirectDisplayID MCUVirtualDisplayCreate(const char *name, uint32_t width, uint32_t height) {
    Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
    Class displayClass = NSClassFromString(@"CGVirtualDisplay");
    Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
    Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
    if (!descriptorClass || !displayClass || !settingsClass || !modeClass) return 0;

    id<MCUVirtualDisplayDescriptor> descriptor = [[descriptorClass alloc] init];
    descriptor.name = [NSString stringWithUTF8String:name];
    descriptor.maxPixelsWide = width;
    descriptor.maxPixelsHigh = height;
    // About 96 dpi, so the system does not pick a scaled mode.
    descriptor.sizeInMillimeters = CGSizeMake(width * 0.26, height * 0.26);
    descriptor.productID = 0x4d43;
    descriptor.vendorID = 0x4d43;
    descriptor.serialNum = 1;
    descriptor.queue = dispatch_get_main_queue();

    id<MCUVirtualDisplay> display = [(id<MCUVirtualDisplay>)[displayClass alloc] initWithDescriptor:descriptor];
    id<MCUVirtualDisplayMode> mode = [(id<MCUVirtualDisplayMode>)[modeClass alloc] initWithWidth:width
                                                                                          height:height
                                                                                     refreshRate:60];
    if (!display || !mode) return 0;
    id<MCUVirtualDisplaySettings> settings = [[settingsClass alloc] init];
    settings.hiDPI = 0;
    settings.modes = @[ mode ];
    if (![display applySettings:settings] || display.displayID == 0) return 0;
    liveDisplays()[@(display.displayID)] = display;
    return display.displayID;
}

void MCUVirtualDisplayDestroy(CGDirectDisplayID display) {
    // Releasing the last reference removes the display.
    [liveDisplays() removeObjectForKey:@(display)];
}
