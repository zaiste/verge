/*
 * Loads the built shim and resolves every relocation, which is what the
 * dynamic linker does when QLDS starts with it in LD_PRELOAD. Run inside
 * an old distribution image, this is the real portability check: the
 * symbol-version floor enforced by tools/build-shim.sh says what the
 * library asks for, this says whether a given glibc can actually give it.
 *
 * Safe to run anywhere: the shim's constructor returns immediately unless
 * the process is named qzeroded.x64, so nothing is hooked here.
 *
 *   cc -o load_test load_test.c -ldl && ./load_test path/to/verge.x64.so
 */
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char** argv) {
    const char* arg = argc > 1 ? argv[1] : "bin/verge.x64.so";

    // Without a slash dlopen searches the library path instead of the
    // working directory, so a bare filename would never be found.
    char path[4096];
    snprintf(path, sizeof(path), "%s%s", strchr(arg, '/') ? "" : "./", arg);

    void* handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        fprintf(stderr, "FAIL: dlopen(%s): %s\n", path, dlerror());
        return 1;
    }

    // The dispatchers are the shim's contract with the engine hooks; if
    // these resolve, the interesting half of the library is present.
    const char* required[] = {
        "ClientCommandDispatcher", "ServerCommandDispatcher",
        "ClientConnectDispatcher", "SetConfigstringDispatcher",
        "Shim_Initialize", "Shim_Shutdown", NULL,
    };
    for (int i = 0; required[i]; i++) {
        dlerror();
        (void)dlsym(handle, required[i]);
        const char* err = dlerror();
        if (err) {
            fprintf(stderr, "FAIL: %s missing: %s\n", required[i], err);
            dlclose(handle);
            return 1;
        }
    }

    dlclose(handle);
    printf("OK: %s loaded and resolved\n", path);
    return 0;
}
