package config

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDevelopmentMailRequiresLoopbackAndExplicitOptIn(t *testing.T) {
	for _, key := range []string{"AUTH_SECRET_FILE", "RESEND_API_KEY", "RESEND_API_KEY_FILE", "MIGRATION_REHEARSAL", "ADMIN_USERNAME", "ADMIN_EMAIL", "ADMIN_TOTP_SECRET", "ADMIN_TOTP_SECRET_FILE"} {
		t.Setenv(key, "")
	}
	t.Setenv("AUTH_SECRET", strings.Repeat("a1", 32))
	t.Setenv("PUBLIC_ORIGIN", "http://127.0.0.1:8093")
	t.Setenv("MAIL_ENABLED", "false")
	t.Setenv("DEV_MAIL_OUTBOX_DIR", t.TempDir())
	if h, err := LoadHTTP(); err != nil || h.Auth.Sender != nil {
		t.Fatal("development mail enabled without opt-in", err)
	}
	t.Setenv("MAIL_ENABLED", "true")
	if h, err := LoadHTTP(); err != nil || h.Auth.Sender == nil {
		t.Fatal("explicit local development mail unavailable", err)
	}
	for _, origin := range []string{"https://shop.example.test", "https://127.0.0.1.example.test"} {
		t.Setenv("PUBLIC_ORIGIN", origin)
		if _, err := LoadHTTP(); err == nil {
			t.Fatal("development mailbox allowed outside loopback")
		}
	}
	t.Setenv("PUBLIC_ORIGIN", "http://127.0.0.1:8093")
	for _, key := range []string{"RESEND_API_KEY", "RESEND_API_KEY_FILE"} {
		t.Setenv(key, "configured-provider")
		if _, err := LoadHTTP(); err == nil {
			t.Fatal("development mailbox allowed with external mail credentials")
		}
		t.Setenv(key, "")
	}
	t.Setenv("DEV_MAIL_OUTBOX_DIR", filepath.Join(t.TempDir(), "missing"))
	if _, err := LoadHTTP(); err == nil {
		t.Fatal("missing mailbox directory accepted")
	}
}

func TestSecretFileAndConflictingSources(t *testing.T) {
	p := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(p, []byte("private-value\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TEST_SECRET_FILE", p)
	t.Setenv("TEST_SECRET", "")
	v, err := Secret("TEST_SECRET")
	if err != nil || v != "private-value" {
		t.Fatal("file secret not loaded")
	}
	t.Setenv("TEST_SECRET", "another-value")
	if _, err = Secret("TEST_SECRET"); err == nil {
		t.Fatal("ambiguous secrets accepted")
	}
}

func TestDatabasePasswordEscapingAndTLSDefault(t *testing.T) {
	for _, key := range []string{"DATABASE_URL", "DATABASE_URL_FILE", "DB_PASSWORD_FILE", "DB_SSLMODE", "LISTEN_ADDR", "WORKER_ID"} {
		t.Setenv(key, "")
	}
	t.Setenv("DB_HOST", "127.0.0.1")
	t.Setenv("DB_USER", "app")
	t.Setenv("DB_NAME", "storefront_test")
	t.Setenv("DB_PASSWORD", "p@ss:/?#% word")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(c.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := u.User.Password()
	if p != "p@ss:/?#% word" || u.Query().Get("sslmode") != "verify-full" {
		t.Fatal("unsafe connection encoding or TLS default")
	}
}

func TestHTTPConfigurationFailsClosed(t *testing.T) {
	t.Setenv("TRAFFIC_PROTECTION_ENABLED", "")
	for _, key := range []string{"PUBLIC_ORIGIN", "AUTH_SECRET", "AUTH_SECRET_FILE", "ADMIN_USERNAME", "ADMIN_EMAIL", "ADMIN_TOTP_SECRET", "ADMIN_TOTP_SECRET_FILE", "MAIL_ENABLED", "TRUSTED_PROXY_CIDRS"} {
		t.Setenv(key, "")
	}
	h, e := LoadHTTP()
	if e != nil || h.Auth.Sender != nil || h.Origin != "http://127.0.0.1:8093" {
		t.Fatal("unsafe HTTP default")
	}
	t.Setenv("TRAFFIC_PROTECTION_ENABLED", "true")
	if h, e = LoadHTTP(); e != nil || !h.TrafficProtection {
		t.Fatal("traffic protection not enabled", e)
	}
	t.Setenv("TRAFFIC_PROTECTION_ENABLED", "typo")
	if _, e = LoadHTTP(); e == nil {
		t.Fatal("invalid traffic protection flag accepted")
	}
	t.Setenv("TRAFFIC_PROTECTION_ENABLED", "")
	for _, origin := range []string{"http://public.example.test", "https://example.test/path", "https://user@example.test", "https://example.test?", "https://example.test#fragment"} {
		t.Setenv("PUBLIC_ORIGIN", origin)
		if _, e = LoadHTTP(); e == nil {
			t.Fatalf("invalid origin accepted: %s", origin)
		}
	}
	t.Setenv("PUBLIC_ORIGIN", "https://example.test")
	for _, value := range []string{"0.0.0.0/0", "::/0", "invalid", "127.0.0.1/32,"} {
		t.Setenv("TRUSTED_PROXY_CIDRS", value)
		if _, e = LoadHTTP(); e == nil {
			t.Fatalf("unsafe proxy list accepted: %s", value)
		}
	}
	t.Setenv("TRUSTED_PROXY_CIDRS", "127.0.0.1/32,::1/128")
	if h, e = LoadHTTP(); e != nil || len(h.TrustedProxies) != 2 {
		t.Fatal("explicit proxies rejected", e)
	}
	t.Setenv("MAIL_ENABLED", "true")
	if _, e = LoadHTTP(); e == nil {
		t.Fatal("mail enabled without auth secret")
	}
}
