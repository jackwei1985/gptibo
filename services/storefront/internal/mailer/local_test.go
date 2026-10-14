package mailer

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"gptibo/storefront/internal/security"
)

func TestLocalOutboxPrivateDeliveryAndInputValidation(t *testing.T) {
	directory := t.TempDir()
	sender, err := NewLocalOutbox(directory)
	if err != nil {
		t.Fatal(err)
	}
	id := security.ID()
	code := security.Code()
	if err = sender.SendCode(context.Background(), "admin", "admin@example.test", code, id); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, id+".json")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var message map[string]string
	if json.Unmarshal(body, &message) != nil || message["code"] != code || message["challenge"] != id || message["to"] != "admin@example.test" {
		t.Fatal("authentication message not captured")
	}
	if info, _ := os.Stat(path); runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("authentication message is not private")
	}
	for _, input := range []struct{ role, to, code, id string }{
		{"admin", "admin@example.test", code, id}, // Existing challenges cannot be overwritten.
		{"admin", "admin@example.test", code, "../outside"},
		{"admin", "invalid", code, security.ID()},
		{"unknown", "admin@example.test", code, security.ID()},
		{"admin", "admin@example.test", "invalid", security.ID()},
	} {
		if sender.SendCode(context.Background(), input.role, input.to, input.code, input.id) == nil {
			t.Fatal("unsafe development message accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if sender.SendCode(ctx, "admin", "admin@example.test", code, security.ID()) == nil {
		t.Fatal("cancelled delivery accepted")
	}
	files, _ := os.ReadDir(directory)
	if len(files) != 1 {
		t.Fatal("rejected messages created files")
	}
}
