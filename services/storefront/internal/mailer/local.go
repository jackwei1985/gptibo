package mailer

import (
	"context"
	"encoding/json"
	"errors"
	"net/mail"
	"os"
	"path/filepath"
	"time"

	"gptibo/storefront/internal/security"
)

// LocalOutbox captures authentication codes in private files for local development.
// It deliberately does not implement the transaction/notification mail Sender.
type LocalOutbox struct{ directory string }

func (s *LocalOutbox) DevelopmentMail() bool { return true }

func NewLocalOutbox(directory string) (*LocalOutbox, error) {
	if !filepath.IsAbs(directory) {
		return nil, errors.New("development mail outbox requires an absolute directory")
	}
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		return nil, errors.New("development mail outbox directory must already exist")
	}
	return &LocalOutbox{directory: directory}, nil
}

func (s *LocalOutbox) SendCode(ctx context.Context, role, to, code, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if (role != "admin" && role != "partner" && role != "customer") || !security.ValidID(id) || !security.ValidCode(code) {
		return errors.New("invalid development authentication message")
	}
	if _, err := mail.ParseAddress(to); err != nil {
		return errors.New("invalid development mail recipient")
	}
	body, err := json.Marshal(struct {
		Role      string    `json:"role"`
		To        string    `json:"to"`
		Code      string    `json:"code"`
		Challenge string    `json:"challenge"`
		CreatedAt time.Time `json:"createdAt"`
	}{role, to, code, id, time.Now().UTC()})
	if err != nil {
		return err
	}
	path := filepath.Join(s.directory, id+".json")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("cannot create development authentication message")
	}
	_, err = file.Write(body)
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		_ = os.Remove(path)
		return errors.New("cannot write development authentication message")
	}
	return nil
}
