package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/othcloud/terminal-backend/internal/auth"
	"github.com/othcloud/terminal-backend/internal/db"
	"github.com/othcloud/terminal-backend/internal/handlers"
)

// defaultMongoURI is the dev cluster URI. Prefer setting OTHCLOUD_MONGO_URI in
// production; this default only exists so the server runs out of the box.
const defaultMongoURI = "mongodb://mongo:b6azptbxidixejnk@82.68.47.67:25029/?authSource=admin&directConnection=true"

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing required env var %s", key)
	}
	return v
}

func corsMiddleware(origin string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Access-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	cfg := auth.Config{
		AccessToken: mustEnv("OTHCLOUD_ACCESS_TOKEN"),
		JWTSecret:   []byte(mustEnv("OTHCLOUD_JWT_SECRET")),
		TokenTTL:    24 * time.Hour,
	}
	addr := envOr("OTHCLOUD_ADDR", ":8787")
	mongoURI := envOr("OTHCLOUD_MONGO_URI", defaultMongoURI)
	mongoDB := envOr("OTHCLOUD_MONGO_DB", "othcloud_terminal")
	corsOrigin := envOr("OTHCLOUD_CORS_ORIGIN", "*")
	handlers.UploadDir = envOr("OTHCLOUD_UPLOAD_DIR", "./uploads")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	conn, err := db.Open(ctx, mongoURI, mongoDB)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer func() {
		shutdownCtx, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = conn.Close(shutdownCtx)
	}()

	srv := &handlers.Server{DB: conn, Auth: cfg}

	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/auth/register", srv.Register)
	mux.HandleFunc("POST /api/auth/login", srv.Login)

	authed := http.NewServeMux()
	authed.HandleFunc("GET /api/auth/me", srv.Me)
	authed.HandleFunc("GET /api/users", srv.ListUsers)

	authed.HandleFunc("GET /api/tasks", srv.ListTasks)
	authed.HandleFunc("POST /api/tasks", srv.CreateTask)
	authed.HandleFunc("GET /api/tasks/{id}", srv.GetTask)
	authed.HandleFunc("PATCH /api/tasks/{id}", srv.PatchTask)

	authed.HandleFunc("GET /api/tasks/{id}/messages", srv.ListMessages)
	authed.HandleFunc("POST /api/tasks/{id}/messages", srv.PostMessage)
	authed.HandleFunc("POST /api/tasks/{id}/messages/upload", srv.PostMessageWithAttachment)

	authed.HandleFunc("GET /api/attachments/{id}", srv.GetAttachment)

	authed.HandleFunc("GET /api/tasks/{id}/checklist", srv.ListChecklist)
	authed.HandleFunc("POST /api/tasks/{id}/checklist", srv.AddChecklistItem)
	authed.HandleFunc("PATCH /api/tasks/{id}/checklist/{itemId}", srv.PatchChecklistItem)

	authed.HandleFunc("GET /api/tasks/{id}/activity", srv.ListActivity)

	authed.HandleFunc("POST /api/tasks/{id}/commits", srv.AddCommit)
	authed.HandleFunc("DELETE /api/tasks/{id}/commits/{commitId}", srv.RemoveCommit)

	authed.HandleFunc("GET /api/tasks/{id}/time", srv.GetTaskTime)
	authed.HandleFunc("POST /api/tasks/{id}/time/start", srv.StartTaskTimer)
	authed.HandleFunc("POST /api/tasks/{id}/time/stop", srv.StopTaskTimer)
	authed.HandleFunc("GET /api/me/active-timer", srv.GetActiveTimer)

	authed.HandleFunc("GET /api/statuses", srv.ListStatuses)
	authed.HandleFunc("POST /api/statuses", srv.AddStatus)
	authed.HandleFunc("DELETE /api/statuses/{key}", srv.DeleteStatus)

	authed.HandleFunc("GET /api/services", srv.ListServices)
	authed.HandleFunc("POST /api/services", srv.CreateService)
	authed.HandleFunc("GET /api/services/{id}", srv.GetService)
	authed.HandleFunc("PATCH /api/services/{id}", srv.PatchService)
	authed.HandleFunc("POST /api/services/{id}/repos", srv.AddServiceRepo)
	authed.HandleFunc("DELETE /api/services/{id}/repos/{repoId}", srv.RemoveServiceRepo)

	mux.Handle("/", auth.RequireUser(cfg, authed))

	handler := auth.AccessTokenMiddleware(cfg, mux)
	handler = corsMiddleware(corsOrigin, handler)

	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("OTerminal backend listening on %s (mongo db=%s)", addr, mongoDB)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}
