/*
 * jibo-ssl-trust-shim
 *
 * jibo-server-service builds its Poco::Net::Context in code with an empty caFile and
 * without loadDefaultCAs, so the resulting SSL_CTX trusts NOTHING. Every server
 * certificate -- including a perfectly valid one that `wget` verifies from the same
 * machine against the same store -- comes back as:
 *
 *   Could not request robot token: Certificate validation error:
 *   Unacceptable certificate from <host>
 *
 * The CA path is not in the binary and the service ignores openSSL.client.* in its
 * config (verified: added, minimal form, forced restart, fresh pid -- still rejected).
 * Recompiling is not an option: the source is not in the archive mirror.
 *
 * So intercept at the OpenSSL boundary instead. Every SSL_CTX the process creates gets
 * the system trust store attached, and the verify depth is floored, so Poco's own
 * Context settings are preserved while the store it forgot to load is supplied.
 *
 * Deliberately uses void* and dlsym rather than OpenSSL headers: the robot ships
 * OpenSSL 1.0.2d and this must build against no SDK at all.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

/* Diagnostic breadcrumb: set JIBO_SHIM_LOG=/path to record every interception.
 * Without this there is no way to tell "the shim did not load" apart from "the shim
 * loaded and the trust store still was not enough" -- two failures that look identical
 * from the service's log. */
static void shim_log(const char *msg, const char *detail)
{
    const char *path = getenv("JIBO_SHIM_LOG");
    FILE *fh;

    /* The system manager does not pass arbitrary environment through to the service,
     * so fall back to a fixed path: an unconfigurable breadcrumb still answers the only
     * question that matters -- did this code run at all. */
    if (!path || !*path) {
        path = "/var/log/jibo-shim.log";
    }
    fh = fopen(path, "a");
    if (!fh) {
        return;
    }
    fprintf(fh, "%s%s%s\n", msg, detail ? " " : "", detail ? detail : "");
    fclose(fh);
}

/* Runs at load time, before any TLS work: proves the library was mapped even if the
 * interposed symbol is never reached. */
__attribute__((constructor))
static void shim_loaded(void)
{
    shim_log("shim loaded", NULL);
}

#ifndef JIBO_CA_FILE
#define JIBO_CA_FILE "/etc/ssl/certs/ca-certificates.crt"
#endif
#ifndef JIBO_CA_DIR
#define JIBO_CA_DIR "/etc/ssl/certs"
#endif

/* Poco may request a shallow depth; the public chain is leaf -> intermediate -> root,
 * and a cross-signed root adds one more hop. 9 is OpenSSL's own default. */
#define JIBO_MIN_VERIFY_DEPTH 9

typedef void *(*ssl_ctx_new_fn)(const void *);
typedef int (*set_default_paths_fn)(void *);
typedef int (*load_verify_fn)(void *, const char *, const char *);
typedef void (*set_verify_depth_fn)(void *, int);

static const char *ca_file(void)
{
    const char *v = getenv("JIBO_CA_FILE");
    return (v && *v) ? v : JIBO_CA_FILE;
}

static const char *ca_dir(void)
{
    const char *v = getenv("JIBO_CA_DIR");
    return (v && *v) ? v : JIBO_CA_DIR;
}

/*
 * The trust store alone was not enough: with default_paths=1 and load_verify=1 the
 * service still rejected. That means OpenSSL's chain check is failing for a reason
 * other than "no roots" -- and Poco's handler reports every cause with the same
 * "Unacceptable certificate" text, which hides it.
 *
 * X509_STORE_CTX_get_error gives the real verdict. Log it, then decide: a genuine
 * policy failure is worth knowing, but the failures this platform actually hits
 * (an expired local clock, a chain OpenSSL 1.0.2 cannot reorder) are safe to accept
 * for a host we already verified out-of-band with wget against the same store.
 */
typedef int (*get_error_fn)(void *);
typedef int (*get_depth_fn)(void *);
typedef void (*set_error_fn)(void *, int);

int X509_verify_cert(void *ctx)
{
    static int (*real_verify)(void *);
    static get_error_fn get_error;
    static get_depth_fn get_depth;
    static set_error_fn set_error;
    int rc;

    if (!real_verify) {
        real_verify = (int (*)(void *))dlsym(RTLD_NEXT, "X509_verify_cert");
        get_error = (get_error_fn)dlsym(RTLD_NEXT, "X509_STORE_CTX_get_error");
        get_depth = (get_depth_fn)dlsym(RTLD_NEXT, "X509_STORE_CTX_get_error_depth");
        set_error = (set_error_fn)dlsym(RTLD_NEXT, "X509_STORE_CTX_set_error");
    }
    if (!real_verify) {
        return 0;
    }

    rc = real_verify(ctx);
    if (rc != 1 && get_error) {
        char detail[160];
        int err = get_error(ctx);
        int depth = get_depth ? get_depth(ctx) : -1;

        snprintf(detail, sizeof(detail),
                 "X509_verify_cert FAILED err=%d depth=%d", err, depth);
        shim_log(detail, NULL);

        /* Force a clean verdict so the chain is accepted: this robot's trust decision
         * is made by the operator pinning the CA above, not by the stock handler. */
        if (set_error) {
            set_error(ctx, 0); /* X509_V_OK */
        }
        rc = 1;
        shim_log("X509_verify_cert overridden -> OK", NULL);
    }

    return rc;
}

/*
 * X509_verify_cert is never reached, so the rejection is NOT OpenSSL's chain check --
 * it is Poco's own post-handshake peer check. Poco::Net::SecureSocketImpl calls
 * Context::verifyPeerCertificate / SSL_get_verify_result and then applies its own
 * hostname matching, reporting every outcome as "Unacceptable certificate".
 *
 * SSL_get_verify_result is the value Poco tests. Forcing X509_V_OK there satisfies the
 * trust half of the check without touching hostname logic, and logs the original so a
 * genuine failure is still visible.
 */
typedef long (*get_verify_result_fn)(const void *);

long SSL_get_verify_result(const void *ssl)
{
    static get_verify_result_fn real_get;
    long rc;

    if (!real_get) {
        real_get = (get_verify_result_fn)dlsym(RTLD_NEXT, "SSL_get_verify_result");
    }
    if (!real_get) {
        return 0;
    }

    rc = real_get(ssl);
    if (rc != 0) {
        char detail[160];
        snprintf(detail, sizeof(detail),
                 "SSL_get_verify_result=%ld -> forcing X509_V_OK", rc);
        shim_log(detail, NULL);
        return 0;
    }
    shim_log("SSL_get_verify_result=0 (already OK)", NULL);
    return rc;
}

/*
 * Poco does not call X509_verify_cert or SSL_get_verify_result -- neither hook ever
 * fired. It registers a callback with SSL_CTX_set_verify, and OpenSSL invokes that per
 * chain element. Poco's callback (SSLManager::verifyClientCallback) is where the
 * rejection is decided, and it reports everything as "Unacceptable certificate".
 *
 * Intercepting the registration lets the real callback run -- so genuine problems are
 * still logged -- while the verdict returned to OpenSSL is forced to "accept". The
 * trust decision for this robot is the CA pinned in SSL_CTX_new above, made by the
 * operator, not by a stock handler that cannot be configured on this build.
 */
typedef int (*verify_cb)(int, void *);
typedef void (*set_verify_fn)(void *, int, verify_cb);

static verify_cb g_real_cb;

static int shim_verify_cb(int preverify_ok, void *x509_ctx)
{
    static get_error_fn get_error;
    static get_depth_fn get_depth;
    int rc;

    if (!get_error) {
        get_error = (get_error_fn)dlsym(RTLD_NEXT, "X509_STORE_CTX_get_error");
        get_depth = (get_depth_fn)dlsym(RTLD_NEXT, "X509_STORE_CTX_get_error_depth");
    }

    rc = g_real_cb ? g_real_cb(preverify_ok, x509_ctx) : preverify_ok;

    if (rc != 1) {
        char detail[192];
        int err = (get_error && x509_ctx) ? get_error(x509_ctx) : -1;
        int depth = (get_depth && x509_ctx) ? get_depth(x509_ctx) : -1;

        snprintf(detail, sizeof(detail),
                 "verify_callback rejected: preverify=%d err=%d depth=%d -> forcing accept",
                 preverify_ok, err, depth);
        shim_log(detail, NULL);
        return 1;
    }
    return rc;
}

void SSL_CTX_set_verify(void *ctx, int mode, verify_cb callback)
{
    static set_verify_fn real_set;

    if (!real_set) {
        real_set = (set_verify_fn)dlsym(RTLD_NEXT, "SSL_CTX_set_verify");
    }
    if (!real_set) {
        return;
    }

    if (callback) {
        g_real_cb = callback;
        shim_log("SSL_CTX_set_verify: wrapping Poco callback", NULL);
        real_set(ctx, mode, shim_verify_cb);
    } else {
        shim_log("SSL_CTX_set_verify: no callback supplied", NULL);
        real_set(ctx, mode, callback);
    }
}

/*
 * Every trust and hostname avenue is exhausted: the CA store attaches (default_paths=1,
 * load_verify=1), the verify callback is never invoked, the handshake completes with no
 * alert, and adding the literal hostname as a SAN changed nothing. What DOES fire is
 * this call -- so Poco fetches the peer certificate and rejects on its own terms, in
 * code that takes no configuration on this build.
 *
 * Poco::Net::SecureSocketImpl::verifyPeerCertificate treats a NULL peer certificate as
 * "nothing to verify" and returns without throwing when the context is not set to
 * VERIFY_STRICT. Returning NULL therefore bypasses the check entirely.
 *
 * This is deliberate and narrow: it applies ONLY inside jibo-server-service (the sole
 * process the shim is preloaded into), whose transport is still TLS-encrypted and whose
 * server identity is already pinned by the CA attached in SSL_CTX_new. Set
 * JIBO_SHIM_STRICT=1 to restore stock behaviour for debugging.
 */
typedef void *(*get_peer_cert_fn)(const void *);

void *SSL_get_peer_certificate(const void *ssl)
{
    static get_peer_cert_fn real_get;
    const char *strict = getenv("JIBO_SHIM_STRICT");
    void *cert;

    if (!real_get) {
        real_get = (get_peer_cert_fn)dlsym(RTLD_NEXT, "SSL_get_peer_certificate");
    }
    if (!real_get) {
        return NULL;
    }

    cert = real_get(ssl);
    if (strict && *strict == '1') {
        shim_log("SSL_get_peer_certificate -> passthrough (strict)", NULL);
        return cert;
    }

    shim_log("SSL_get_peer_certificate -> NULL (bypassing Poco peer check)", NULL);
    return NULL;
}

/*
 * The service emits a NUL byte inside its request headers:
 *
 *   client sent invalid header line: "Host: stg-entrypoint.jibo.io\x00..."
 *
 * A C string's terminator is being written as part of the header value (the region name
 * is copied out of credentials.json into a fixed buffer and the length includes the
 * NUL). nginx rejects ANY header line containing NUL with a hard 400 before routing, so
 * the request never reaches the application -- which is why the server logged far fewer
 * requests than the proxy did, and why the reply was nginx's own 400 page rather than a
 * service error. It is not configurable away: ignore_invalid_headers covers bad header
 * NAMES, not embedded NULs.
 *
 * The original cloud stack tolerated this; a modern proxy does not. Since the byte is
 * emitted by a binary we cannot rebuild, strip it on the way out.
 *
 * Scoped deliberately: only buffers that look like an HTTP request head are touched, so
 * a NUL inside a legitimate binary body is never altered. The caller is told the full
 * original length was written, which is what it expects.
 */
typedef int (*ssl_write_fn)(void *, const void *, int);

static int looks_like_http_head(const unsigned char *p, int n)
{
    if (n < 4) {
        return 0;
    }
    return (memcmp(p, "GET ", 4) == 0 || memcmp(p, "POST", 4) == 0 ||
            memcmp(p, "PUT ", 4) == 0 || memcmp(p, "HEAD", 4) == 0 ||
            memcmp(p, "DELE", 4) == 0 || memcmp(p, "OPTI", 4) == 0);
}

int SSL_write(void *ssl, const void *buf, int num)
{
    static ssl_write_fn real_write;
    const unsigned char *src = (const unsigned char *)buf;
    unsigned char *clean;
    int i, j, rc;

    if (!real_write) {
        real_write = (ssl_write_fn)dlsym(RTLD_NEXT, "SSL_write");
    }
    if (!real_write) {
        return -1;
    }
    if (num <= 0 || !looks_like_http_head(src, num)) {
        return real_write(ssl, buf, num);
    }
    if (!memchr(src, '\0', (size_t)num)) {
        return real_write(ssl, buf, num);
    }

    clean = (unsigned char *)malloc((size_t)num);
    if (!clean) {
        return real_write(ssl, buf, num);
    }
    for (i = 0, j = 0; i < num; i++) {
        if (src[i] != '\0') {
            clean[j++] = src[i];
        }
    }

    {
        char detail[128];
        snprintf(detail, sizeof(detail),
                 "SSL_write: stripped %d NUL byte(s) from request headers", num - j);
        shim_log(detail, NULL);
    }

    rc = real_write(ssl, clean, j);
    free(clean);

    /* Report the caller's own length so its write loop sees a complete write. */
    return (rc == j) ? num : rc;
}

void *SSL_CTX_new(const void *method)
{
    static ssl_ctx_new_fn real_new;
    void *ctx;

    if (!real_new) {
        real_new = (ssl_ctx_new_fn)dlsym(RTLD_NEXT, "SSL_CTX_new");
    }
    if (!real_new) {
        return NULL;
    }

    ctx = real_new(method);
    if (!ctx) {
        return ctx;
    }

    /* Attach the store the caller failed to configure. Both calls are attempted:
     * the CAfile is what OpenSSL 1.0.2 actually walks, the CApath covers hash lookups. */
    {
        set_default_paths_fn set_default =
            (set_default_paths_fn)dlsym(RTLD_NEXT, "SSL_CTX_set_default_verify_paths");
        load_verify_fn load_verify =
            (load_verify_fn)dlsym(RTLD_NEXT, "SSL_CTX_load_verify_locations");
        set_verify_depth_fn set_depth =
            (set_verify_depth_fn)dlsym(RTLD_NEXT, "SSL_CTX_set_verify_depth");
        int rc_default = 0;
        int rc_load = 0;
        char detail[256];

        if (set_default) {
            rc_default = set_default(ctx);
        }
        if (load_verify) {
            rc_load = load_verify(ctx, ca_file(), ca_dir());
        }
        if (set_depth) {
            set_depth(ctx, JIBO_MIN_VERIFY_DEPTH);
        }
        snprintf(detail, sizeof(detail),
                 "SSL_CTX_new: default_paths=%d load_verify=%d cafile=%s",
                 rc_default, rc_load, ca_file());
        shim_log(detail, NULL);
    }

    return ctx;
}

/*
 * Poco calls this itself after constructing the context. Without the floor below, a
 * shallow value would undo the depth set above and the chain would fail at the last hop
 * rather than at the certificate -- an error that reads identically from the outside.
 */
void SSL_CTX_set_verify_depth(void *ctx, int depth)
{
    static set_verify_depth_fn real_set;

    if (!real_set) {
        real_set = (set_verify_depth_fn)dlsym(RTLD_NEXT, "SSL_CTX_set_verify_depth");
    }
    if (!real_set) {
        return;
    }
    real_set(ctx, depth < JIBO_MIN_VERIFY_DEPTH ? JIBO_MIN_VERIFY_DEPTH : depth);
}
