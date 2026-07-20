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
CFLAGS += -shared -std=gnu11 -Wall -pthread
LDFLAGS += -ldl -lm -pthread
VERSION := MINQLX_VERSION=\"$(shell git describe --long --tags --dirty --always)\"

CORE_SOURCES = core/dllmain.c core/commands.c core/simple_hook.c core/hooks.c \
               core/misc.c core/maps_parser.c core/trampoline.c core/patches.c $(HDE)
SHIM_SOURCES = shim/shim_ipc.c shim/shim_dispatch.c shim/shim_rpc.c shim/cJSON.c

SOURCES = $(CORE_SOURCES) $(SHIM_SOURCES)
OBJS = $(SOURCES:.c=.o)
OBJS_NOPY = $(CORE_SOURCES:.c=.nopy.o)
OUTPUT = $(BINDIR)/minqlx$(SUFFIX).so
OUTPUT_NOPY = $(BINDIR)/minqlx_nopy.so

.PHONY: all so debug nopy nopy_debug runtime clean

all: so

so: $(OUTPUT)
	@echo Done!

debug: CFLAGS += -gdwarf-2 -O0 -fvar-tracking
debug: $(OUTPUT)
	@echo Done!

# Diagnostic baseline: the pure hook core with no sidecar at all.
nopy: CFLAGS += -DNOPY
nopy: $(OUTPUT_NOPY)
	@echo Done!

nopy_debug: CFLAGS += -gdwarf-2 -O0 -DNOPY
nopy_debug: $(OUTPUT_NOPY)
	@echo Done!

# Bundles the TypeScript runtime + plugins into bin/minqlx/ (requires bun).
runtime:
	cd runtime && bun install --frozen-lockfile && bun run bundle

$(OUTPUT): $(OBJS)
	@mkdir -p $(BINDIR)
	$(CC) $(CFLAGS) -D$(VERSION) -o $(OUTPUT) $(OBJS) $(LDFLAGS)

$(OUTPUT_NOPY): $(OBJS_NOPY)
	@mkdir -p $(BINDIR)
	$(CC) $(CFLAGS) -D$(VERSION) -o $(OUTPUT_NOPY) $(OBJS_NOPY) $(LDFLAGS)

%.o: %.c
	$(CC) $(CFLAGS) -D$(VERSION) -c $< -o $@

%.nopy.o: %.c
	$(CC) $(CFLAGS) -D$(VERSION) -c $< -o $@

clean:
	@echo Cleaning...
	@$(RM) core/*.o core/HDE/*.o shim/*.o core/*~ shim/*~ $(OUTPUT) $(OUTPUT_NOPY)
	@echo Done!
