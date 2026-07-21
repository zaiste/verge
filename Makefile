LBITS := $(shell getconf LONG_BIT)
ifeq ($(LBITS),64)
	CFLAGS += -m64 -fPIC
	HDE = core/HDE/hde64.c
	SUFFIX = .x64
else
	CFLAGS += -m32 -fPIC
	HDE = core/HDE/hde32.c
	SUFFIX = .x86
endif

BINDIR = bin
CC ?= gcc
CFLAGS += -shared -std=gnu11 -Wall -pthread -O2
# The pattern scanner reads unaligned ints by design (fine on x86); zig cc
# would otherwise trap them with its default UBSan.
CFLAGS += -fno-sanitize=undefined
LDFLAGS += -ldl -lm -pthread
VERSION := VERGE_VERSION=\"$(shell git describe --long --tags --dirty --always)\"

CORE_SOURCES = core/dllmain.c core/commands.c core/simple_hook.c core/hooks.c \
               core/misc.c core/maps_parser.c core/trampoline.c core/patches.c $(HDE)
SHIM_SOURCES = shim/shim_ipc.c shim/shim_dispatch.c shim/shim_rpc.c shim/cJSON.c

SOURCES = $(CORE_SOURCES) $(SHIM_SOURCES)
OBJS = $(SOURCES:.c=.o)
OUTPUT = $(BINDIR)/verge$(SUFFIX).so

.PHONY: all so debug runtime clean

all: so

so: $(OUTPUT)
	@echo Done!

debug: CFLAGS += -gdwarf-2 -O0 -fvar-tracking
debug: $(OUTPUT)
	@echo Done!

# Bundles the TypeScript runtime + plugins into bin/verge/ (requires bun).
runtime:
	cd runtime && bun install --frozen-lockfile && bun run bundle

$(OUTPUT): $(OBJS)
	@mkdir -p $(BINDIR)
	$(CC) $(CFLAGS) -D$(VERSION) -o $(OUTPUT) $(OBJS) $(LDFLAGS)

%.o: %.c
	$(CC) $(CFLAGS) -D$(VERSION) -c $< -o $@

clean:
	@echo Cleaning...
	@$(RM) core/*.o core/HDE/*.o shim/*.o core/*~ shim/*~ $(OUTPUT)
	@echo Done!
