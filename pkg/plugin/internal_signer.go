package plugin

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"strconv"
	"time"
)

// nonceSize is the number of random bytes used to build the per-request
// replay-defense nonce (hex-encoded, so the header value is 2x this length).
const nonceSize = 16

// signInternalRequest signs an internal proxy request bound for the ORCA
// FastAPI backend. It sets:
//
//	X-Agent-Signature: HMAC-SHA256(method:timestamp:nonce:target:body_sha256:org_id, secret)
//	X-Agent-Timestamp: <unix timestamp>
//	X-Agent-Nonce:     <random per-request token>
//
// where "target" is req.URL.EscapedPath() plus "?"+req.URL.RawQuery when a
// query string is present, and "org_id" is the verbatim value of the
// X-Grafana-Org-Id header (already injected by the caller before this
// function runs). The nonce is bound into the signed message itself so it
// cannot be stripped or swapped by a replaying attacker without invalidating
// the signature — see docs/harness-risk-review.md F7.
//
// EscapedPath() (not the decoded Path field) is used deliberately: it is the
// exact percent-encoded byte representation httputil.ReverseProxy writes
// onto the wire (net/url.URL.RequestURI() calls EscapedPath() internally),
// so signing it ties the signature to what is *actually sent*, rather than
// to a decoded string that depends on Go's escape/unescape round-trip
// happening to agree with whatever the receiving ASGI server does. The
// receiving InternalAuthMiddleware (harness/auth/internal_auth.py) verifies
// using the equivalent raw encoded representation — Starlette/uvicorn's
// ASGI `raw_path` — not the ASGI-decoded `request.url.path`, so both sides
// canonicalise on the literal wire bytes rather than on a decoded
// approximation of them.
//
// The receiving InternalAuthMiddleware MUST use the exact same
// canonicalisation to verify.
//
// req.URL.Path/RawPath, req.URL.RawQuery, and the X-Grafana-Org-Id header
// must already reflect their final, forwarded values before calling this
// function — it signs exactly what will be sent to the backend.
//
// This is a no-op (returns nil, sets no headers) when secret is empty, which
// preserves the existing dev-mode pass-through behaviour.
func signInternalRequest(req *http.Request, secret string) error {
	if secret == "" {
		return nil
	}

	body, err := readAndRestoreBody(req)
	if err != nil {
		return err
	}
	bodyHash := sha256.Sum256(body)

	nonce, err := randomNonce()
	if err != nil {
		return err
	}

	ts := strconv.FormatInt(time.Now().Unix(), 10)

	target := req.URL.EscapedPath()
	if req.URL.RawQuery != "" {
		target = target + "?" + req.URL.RawQuery
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")

	message := req.Method + ":" + ts + ":" + nonce + ":" + target + ":" + hex.EncodeToString(bodyHash[:]) + ":" + orgID
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message))

	req.Header.Set("X-Agent-Signature", hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set("X-Agent-Timestamp", ts)
	req.Header.Set("X-Agent-Nonce", nonce)
	return nil
}

// readAndRestoreBody fully reads req.Body (if any) and replaces it with a
// fresh reader over the same bytes, so the request body is still available
// for the reverse proxy to forward to the backend after we've hashed it.
func readAndRestoreBody(req *http.Request) ([]byte, error) {
	if req.Body == nil || req.Body == http.NoBody {
		return []byte{}, nil
	}
	data, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	_ = req.Body.Close()
	req.Body = io.NopCloser(bytes.NewReader(data))
	req.ContentLength = int64(len(data))
	return data, nil
}

// randomNonce returns a random nonceSize-byte value, hex-encoded.
func randomNonce() (string, error) {
	buf := make([]byte, nonceSize)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
