package plugin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

type peerRfPluginSettings struct {
	PeerRfControlURL string `json:"peerRfControlUrl"`
}

type peerRfEnrollRequest struct {
	MachineID string `json:"machineId"`
	Backfill  *bool  `json:"backfill"`
}

func (a *App) handlePeerRfMachines(w http.ResponseWriter, r *http.Request) {
	cfg, token, baseURL, err := a.peerRfControlConfig(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	_ = cfg

	if !isGrafanaAdmin(r) {
		http.Error(w, "Grafana Admin role required to manage peer-RF enrollment", http.StatusForbidden)
		return
	}

	switch r.Method {
	case http.MethodGet:
		a.proxyPeerRf(w, r, baseURL, token, http.MethodGet, "/peer-rf/machines", nil)
	case http.MethodPost:
		body, readErr := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if readErr != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}
		var req peerRfEnrollRequest
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		req.MachineID = strings.TrimSpace(req.MachineID)
		if req.MachineID == "" {
			http.Error(w, "machineId is required", http.StatusBadRequest)
			return
		}
		backfill := true
		if req.Backfill != nil {
			backfill = *req.Backfill
		}
		payload, _ := json.Marshal(map[string]any{
			"machineId": req.MachineID,
			"backfill":  backfill,
		})
		a.proxyPeerRf(w, r, baseURL, token, http.MethodPost, "/peer-rf/machines", payload)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *App) handlePeerRfMachineStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, token, baseURL, err := a.peerRfControlConfig(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	if !isGrafanaAdmin(r) {
		http.Error(w, "Grafana Admin role required", http.StatusForbidden)
		return
	}
	machineID := strings.TrimPrefix(r.URL.Path, "/peer-rf/machines/")
	machineID = strings.Trim(machineID, "/")
	if machineID == "" || strings.Contains(machineID, "/") {
		http.Error(w, "machine id required", http.StatusBadRequest)
		return
	}
	path := "/peer-rf/machines/" + url.PathEscape(machineID)
	a.proxyPeerRf(w, r, baseURL, token, http.MethodGet, path, nil)
}

func (a *App) handlePeerRfHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, token, baseURL, err := a.peerRfControlConfig(r)
	configured := err == nil && baseURL != "" && token != ""
	status := map[string]any{
		"ok":               configured,
		"controlConfigured": configured,
	}
	if !configured {
		status["error"] = "Set peerRfControlUrl (jsonData) and peerRfControlToken (secureJsonData) in Graft plugin settings"
		writeJSON(w, http.StatusOK, status)
		return
	}
	// Probe exporter health (no admin required for "is it configured" — but probing needs token)
	if !isGrafanaAdmin(r) {
		writeJSON(w, http.StatusOK, status)
		return
	}
	resp, proxyErr := a.doPeerRfRequest(baseURL, token, http.MethodGet, "/health", nil)
	if proxyErr != nil {
		status["ok"] = false
		status["error"] = proxyErr.Error()
		writeJSON(w, http.StatusOK, status)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	status["exporterStatus"] = resp.StatusCode
	status["exporterBody"] = json.RawMessage(body)
	if resp.StatusCode >= 300 {
		status["ok"] = false
	}
	writeJSON(w, http.StatusOK, status)
}

func (a *App) peerRfControlConfig(r *http.Request) (peerRfPluginSettings, string, string, error) {
	pluginConfig := httpadapter.PluginConfigFromContext(r.Context())
	if pluginConfig.AppInstanceSettings == nil {
		return peerRfPluginSettings{}, "", "", fmt.Errorf("plugin settings not available")
	}
	var settings peerRfPluginSettings
	if len(pluginConfig.AppInstanceSettings.JSONData) > 0 {
		_ = json.Unmarshal(pluginConfig.AppInstanceSettings.JSONData, &settings)
	}
	baseURL := strings.TrimRight(strings.TrimSpace(settings.PeerRfControlURL), "/")
	token := ""
	if pluginConfig.AppInstanceSettings.DecryptedSecureJSONData != nil {
		token = strings.TrimSpace(pluginConfig.AppInstanceSettings.DecryptedSecureJSONData["peerRfControlToken"])
	}
	if baseURL == "" || token == "" {
		return settings, token, baseURL, fmt.Errorf(
			"peer-RF control not configured (need peerRfControlUrl + peerRfControlToken in plugin settings)",
		)
	}
	return settings, token, baseURL, nil
}

func (a *App) proxyPeerRf(
	w http.ResponseWriter,
	r *http.Request,
	baseURL, token, method, path string,
	body []byte,
) {
	resp, err := a.doPeerRfRequest(baseURL, token, method, path, body)
	if err != nil {
		log.DefaultLogger.Error("peer-rf proxy", "error", err, "path", path)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		http.Error(w, "failed to read exporter response", http.StatusBadGateway)
		return
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
}

func (a *App) doPeerRfRequest(baseURL, token, method, path string, body []byte) (*http.Response, error) {
	u := baseURL + path
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, u, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: 60 * time.Second}
	return client.Do(req)
}

func isGrafanaAdmin(r *http.Request) bool {
	cfg := httpadapter.PluginConfigFromContext(r.Context())
	if cfg.User == nil {
		return false
	}
	role := strings.ToLower(strings.TrimSpace(cfg.User.Role))
	return role == "admin"
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
