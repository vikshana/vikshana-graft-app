package plugin

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// signInternalRequest unit tests
// ---------------------------------------------------------------------------

// recomputeSignature independently reproduces the canonicalisation documented
// on signInternalRequest / harness/auth/internal_auth.py, so tests can verify
// the produced signature without simply calling the function under test again.
func recomputeSignature(secret, method, ts, nonce, target, body, orgID string) string {
	bodyHash := sha256.Sum256([]byte(body))
	message := method + ":" + ts + ":" + nonce + ":" + target + ":" + hex.EncodeToString(bodyHash[:]) + ":" + orgID
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestSignInternalRequestNoOpWithEmptySecret(t *testing.T) {
	req := httptest.NewRequest("GET", "http://example/api/sessions", nil)
	err := signInternalRequest(req, "")
	require.NoError(t, err)

	assert.Empty(t, req.Header.Get("X-Agent-Signature"))
	assert.Empty(t, req.Header.Get("X-Agent-Timestamp"))
	assert.Empty(t, req.Header.Get("X-Agent-Nonce"))
}

func TestSignInternalRequestSetsHeaders(t *testing.T) {
	req := httptest.NewRequest("GET", "http://example/api/sessions/list", nil)
	req.Header.Set("X-Grafana-Org-Id", "7")

	err := signInternalRequest(req, "s3cr3t")
	require.NoError(t, err)

	sig := req.Header.Get("X-Agent-Signature")
	ts := req.Header.Get("X-Agent-Timestamp")
	nonce := req.Header.Get("X-Agent-Nonce")

	assert.Len(t, sig, 64, "HMAC-SHA256 hex digest should be 64 chars")
	assert.NotEmpty(t, ts)
	assert.Len(t, nonce, nonceSize*2, "nonce should be hex-encoded nonceSize bytes")

	tsInt, err := parseTimestamp(ts)
	require.NoError(t, err)
	assert.WithinDuration(t, time.Now(), time.Unix(tsInt, 0), 5*time.Second)
}

func TestSignInternalRequestSignatureMatchesFormula(t *testing.T) {
	req := httptest.NewRequest("POST", "http://example/api/sessions/turn?limit=5", strings.NewReader(`{"a":1}`))
	req.Header.Set("X-Grafana-Org-Id", "42")

	require.NoError(t, signInternalRequest(req, "the-secret"))

	sig := req.Header.Get("X-Agent-Signature")
	ts := req.Header.Get("X-Agent-Timestamp")
	nonce := req.Header.Get("X-Agent-Nonce")

	// Body must have been restored for forwarding.
	body, err := io.ReadAll(req.Body)
	require.NoError(t, err)
	assert.Equal(t, `{"a":1}`, string(body))

	expected := recomputeSignature("the-secret", "POST", ts, nonce, "/api/sessions/turn?limit=5", `{"a":1}`, "42")
	assert.Equal(t, expected, sig)
}

func TestSignInternalRequestBindsBody(t *testing.T) {
	build := func(body string) string {
		req := httptest.NewRequest("POST", "http://example/api/mcp/servers", strings.NewReader(body))
		req.Header.Set("X-Grafana-Org-Id", "1")
		require.NoError(t, signInternalRequest(req, "secret"))
		return req.Header.Get("X-Agent-Signature")
	}

	sigA := build(`{"name":"a"}`)
	sigB := build(`{"name":"b"}`)
	assert.NotEqual(t, sigA, sigB, "different bodies must produce different signatures")
}

func TestSignInternalRequestBindsQuery(t *testing.T) {
	build := func(rawURL string) string {
		req := httptest.NewRequest("GET", rawURL, nil)
		req.Header.Set("X-Grafana-Org-Id", "1")
		require.NoError(t, signInternalRequest(req, "secret"))
		return req.Header.Get("X-Agent-Signature")
	}

	sigA := build("http://example/api/rca?page=1")
	sigB := build("http://example/api/rca?page=2")
	assert.NotEqual(t, sigA, sigB, "different query strings must produce different signatures")
}

// TestSignInternalRequestUsesEscapedPathNotDecodedPath verifies that the
// signed target is the raw, percent-encoded path (req.URL.EscapedPath()) —
// exactly what httputil.ReverseProxy will put on the wire — rather than the
// decoded req.URL.Path. A path segment containing a percent-encoded
// character (here, "%20") is the simplest case where the two representations
// diverge; mirrors
// tests/unit/auth/test_internal_auth.py::TestRawTargetPath on the Python
// side, which must canonicalise on the same raw representation for the
// signature to ever match across the proxy boundary.
func TestSignInternalRequestUsesEscapedPathNotDecodedPath(t *testing.T) {
	req := httptest.NewRequest("GET", "http://example/api/mcp/servers/my%20server", nil)
	req.Header.Set("X-Grafana-Org-Id", "1")

	require.NoError(t, signInternalRequest(req, "secret"))

	sig := req.Header.Get("X-Agent-Signature")
	ts := req.Header.Get("X-Agent-Timestamp")
	nonce := req.Header.Get("X-Agent-Nonce")

	// Sanity: confirm the decoded and escaped representations actually
	// differ for this input — otherwise this test wouldn't exercise
	// anything.
	require.Equal(t, "/api/mcp/servers/my server", req.URL.Path)
	require.Equal(t, "/api/mcp/servers/my%20server", req.URL.EscapedPath())

	expectedFromEscaped := recomputeSignature("secret", "GET", ts, nonce, "/api/mcp/servers/my%20server", "", "1")
	expectedFromDecoded := recomputeSignature("secret", "GET", ts, nonce, "/api/mcp/servers/my server", "", "1")

	assert.Equal(t, expectedFromEscaped, sig,
		"signature must be computed over the raw encoded path (EscapedPath), matching what is actually sent on the wire")
	assert.NotEqual(t, expectedFromDecoded, sig,
		"signing the decoded path would reintroduce the raw-vs-decoded ambiguity this canonicalisation fixes")
}

func TestSignInternalRequestBindsOrgID(t *testing.T) {
	build := func(orgID string) string {
		req := httptest.NewRequest("GET", "http://example/api/rca", nil)
		if orgID != "" {
			req.Header.Set("X-Grafana-Org-Id", orgID)
		}
		require.NoError(t, signInternalRequest(req, "secret"))
		return req.Header.Get("X-Agent-Signature")
	}

	sigA := build("1")
	sigB := build("2")
	assert.NotEqual(t, sigA, sigB, "different org IDs must produce different signatures")
}

func TestSignInternalRequestBindsMethod(t *testing.T) {
	build := func(method string) string {
		req := httptest.NewRequest(method, "http://example/api/rca", nil)
		req.Header.Set("X-Grafana-Org-Id", "1")
		require.NoError(t, signInternalRequest(req, "secret"))
		return req.Header.Get("X-Agent-Signature")
	}

	sigGet := build("GET")
	sigDelete := build("DELETE")
	assert.NotEqual(t, sigGet, sigDelete, "different methods must produce different signatures")
}

func TestSignInternalRequestNoncesAreRandomPerCall(t *testing.T) {
	req1 := httptest.NewRequest("GET", "http://example/api/rca", nil)
	require.NoError(t, signInternalRequest(req1, "secret"))

	req2 := httptest.NewRequest("GET", "http://example/api/rca", nil)
	require.NoError(t, signInternalRequest(req2, "secret"))

	nonce1 := req1.Header.Get("X-Agent-Nonce")
	nonce2 := req2.Header.Get("X-Agent-Nonce")

	assert.NotEqual(t, nonce1, nonce2, "each signed request should get a fresh nonce")
	assert.NotEqual(t, req1.Header.Get("X-Agent-Signature"), req2.Header.Get("X-Agent-Signature"),
		"signatures should differ because the nonce is bound into the signed message")
}

func TestSignInternalRequestPreservesBodyForForwarding(t *testing.T) {
	original := []byte(`{"hello":"world"}`)
	req := httptest.NewRequest("POST", "http://example/api/mcp/servers", bytes.NewReader(original))

	require.NoError(t, signInternalRequest(req, "secret"))

	got, err := io.ReadAll(req.Body)
	require.NoError(t, err)
	assert.Equal(t, original, got, "request body must be restored unchanged after signing")
	assert.Equal(t, int64(len(original)), req.ContentLength)
}

func TestSignInternalRequestNilBody(t *testing.T) {
	req := httptest.NewRequest("GET", "http://example/api/rca", nil)
	req.Body = nil

	err := signInternalRequest(req, "secret")
	require.NoError(t, err)
	assert.NotEmpty(t, req.Header.Get("X-Agent-Signature"))
}

// ---------------------------------------------------------------------------
// randomNonce unit tests
// ---------------------------------------------------------------------------

func TestRandomNonceFormat(t *testing.T) {
	n, err := randomNonce()
	require.NoError(t, err)
	assert.Len(t, n, nonceSize*2)
	_, err = hex.DecodeString(n)
	assert.NoError(t, err, "nonce should be valid hex")
}

func TestRandomNonceUnique(t *testing.T) {
	n1, err := randomNonce()
	require.NoError(t, err)
	n2, err := randomNonce()
	require.NoError(t, err)
	assert.NotEqual(t, n1, n2)
}
