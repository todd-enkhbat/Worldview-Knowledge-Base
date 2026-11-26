// Electron can report success for non-exclusive Carbon hotkeys. Check the
// user's symbolic shortcuts and hold a kernel lock across Worldview profiles.
#include <Carbon/Carbon.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

static int key_code(const char *key) {
    const char *special[] = {"space","left","right","down","up","f1","f2","f3","f4","f5","f6","f7","f8","f9","f10","f11","f12","f13","f14","f15","f16","f17","f18","f19","f20"};
    const int codes[] = {49,123,124,125,126,122,120,99,118,96,97,98,100,101,109,103,111,105,107,113,106,64,79,80,90};
    for (size_t i=0;i<sizeof(codes)/sizeof(codes[0]);i++) if (!strcmp(key,special[i])) return codes[i];
    if (strlen(key)!=1) return -1;
    TISInputSourceRef source=TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
    if (!source) return -1;
    CFDataRef data=TISGetInputSourceProperty(source,kTISPropertyUnicodeKeyLayoutData);
    int found=-1;
    if (data) for (UInt16 i=0;i<128;i++) {
        UInt32 dead=0; UniChar out[4]; UniCharCount count=0;
        if (UCKeyTranslate((const UCKeyboardLayout *)CFDataGetBytePtr(data),i,kUCKeyActionDisplay,0,LMGetKbdType(),
            kUCKeyTranslateNoDeadKeysMask,&dead,4,&count,out)==noErr && count==1 && out[0]==(unsigned char)key[0]) {found=i;break;}
    }
    CFRelease(source);
    return found;
}

static int number(CFDictionaryRef record,CFStringRef field) {
    int value=-1;
    CFNumberRef n=CFDictionaryGetValue(record,field);
    if (n && CFGetTypeID(n)==CFNumberGetTypeID()) CFNumberGetValue(n,kCFNumberIntType,&value);
    return value;
}

int main(int argc,char **argv) {
    if (argc!=4) return 2;
    int code=key_code(argv[2]), mods=atoi(argv[3]);
    CFArrayRef hotkeys=NULL;
    if(code>=0 && CopySymbolicHotKeys(&hotkeys)==noErr && hotkeys) {
        for(CFIndex i=0;i<CFArrayGetCount(hotkeys);i++) {
            CFDictionaryRef item=CFArrayGetValueAtIndex(hotkeys,i);
            if(CFDictionaryGetValue(item,kHISymbolicHotKeyEnabled)==kCFBooleanTrue &&
               number(item,kHISymbolicHotKeyCode)==code && number(item,kHISymbolicHotKeyModifiers)==mods) {
                puts("conflict");CFRelease(hotkeys);return 1;
            }
        }
        CFRelease(hotkeys);
    }
    int fd=open(argv[1],O_RDWR|O_CREAT|O_NOFOLLOW,0600);
    if(fd<0)return 2;
    if(flock(fd,LOCK_EX|LOCK_NB)!=0){puts("conflict");close(fd);return 1;}
    puts("ready");fflush(stdout);
    char buffer[16];while(read(STDIN_FILENO,buffer,sizeof(buffer))>0){}
    close(fd);return 0;
}
