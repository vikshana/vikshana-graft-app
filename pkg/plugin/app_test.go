package plugin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/assert"
)

func TestNewApp(t *testing.T) {
	settings := backend.AppInstanceSettings{
		JSONData: []byte(`{}`),
	}

	appInstance, err := NewApp(context.Background(), settings)
	assert.NoError(t, err)
	assert.NotNil(t, appInstance)
}

func TestCheckHealth(t *testing.T) {
	settings := backend.AppInstanceSettings{
		JSONData: []byte(`{}`),
	}

	appInstance, err := NewApp(context.Background(), settings)
	assert.NoError(t, err)

	app := appInstance.(*App)
	result, err := app.CheckHealth(context.Background(), &backend.CheckHealthRequest{})

	assert.NoError(t, err)
	assert.Equal(t, backend.HealthStatusOk, result.Status)
	assert.Contains(t, result.Message, "Plugin is running")
}

func TestHandlePing(t *testing.T) {
	settings := backend.AppInstanceSettings{
		JSONData: []byte(`{}`),
	}

	appInstance, err := NewApp(context.Background(), settings)
	assert.NoError(t, err)

	app := appInstance.(*App)

	mux := http.NewServeMux()
	app.registerRoutes(mux)

	req := httptest.NewRequest("GET", "/ping", nil)
	w := httptest.NewRecorder()

	mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "ok")
}
