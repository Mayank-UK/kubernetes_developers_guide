package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	listenAddr = ":8080"
	commonsAPI = "https://commons.wikimedia.org/w/api.php"
	userAgent  = "docker-learning-project/1.0"
)

// httpClient is shared for all outbound calls to the Commons API.
var httpClient = &http.Client{Timeout: 10 * time.Second}

// commonsPage is one entry of query.pages in the Commons API response.
type commonsPage struct {
	Index     int    `json:"index"`
	Title     string `json:"title"`
	ImageInfo []struct {
		URL string `json:"url"`
	} `json:"imageinfo"`
}

// commonsResponse is the subset of the Commons API response we care about.
type commonsResponse struct {
	Query struct {
		Pages map[string]commonsPage `json:"pages"`
	} `json:"query"`
}

// imageResponse is the service's JSON contract. Pointers marshal as null
// when there is no result, and the key is always present.
type imageResponse struct {
	Topic     string  `json:"topic"`
	ImageURL  *string `json:"imageUrl"`
	PageTitle *string `json:"pageTitle"`
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func imageHandler(w http.ResponseWriter, r *http.Request) {
	topic := strings.TrimSpace(r.URL.Query().Get("topic"))
	if topic == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "topic is required"})
		log.Printf("%s 400 topic is required", r.URL.Path)
		return
	}

	imageURL, pageTitle, err := searchCommons(topic)
	if err != nil {
		log.Printf("%s topic=%q error: %v", r.URL.Path, topic, err)
	}
	if imageURL != nil {
		log.Printf("%s topic=%q hit %q", r.URL.Path, topic, *imageURL)
	} else {
		log.Printf("%s topic=%q miss", r.URL.Path, topic)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(imageResponse{Topic: topic, ImageURL: imageURL, PageTitle: pageTitle})
}

// searchCommons queries the Wikimedia Commons search API and returns the
// image URL and page title of the most relevant hit (smallest "index"),
// or an error when there is no usable result.
func searchCommons(topic string) (*string, *string, error) {
	params := url.Values{}
	params.Set("action", "query")
	params.Set("format", "json")
	params.Set("generator", "search")
	params.Set("gsrsearch", "filetype:bitmap|drawing "+topic)
	params.Set("gsrlimit", "5")
	params.Set("gsrnamespace", "6")
	params.Set("prop", "imageinfo")
	params.Set("iiprop", "url")

	req, err := http.NewRequest(http.MethodGet, commonsAPI+"?"+params.Encode(), nil)
	if err != nil {
		return nil, nil, fmt.Errorf("build request: %w", err)
	}
	// Wikimedia requires a descriptive User-Agent for API clients.
	req.Header.Set("User-Agent", userAgent)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("commons request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("commons API status %d", resp.StatusCode)
	}

	var parsed commonsResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, nil, fmt.Errorf("decode response: %w", err)
	}

	// query.pages is a map, so iteration order is random: sort by "index"
	// to pick the most relevant page deterministically.
	pages := make([]commonsPage, 0, len(parsed.Query.Pages))
	for _, p := range parsed.Query.Pages {
		pages = append(pages, p)
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Index < pages[j].Index })

	for _, p := range pages {
		if len(p.ImageInfo) > 0 && p.ImageInfo[0].URL != "" {
			u, t := p.ImageInfo[0].URL, p.Title
			return &u, &t, nil
		}
	}
	return nil, nil, fmt.Errorf("no results for topic %q", topic)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/healthz", healthHandler) // Kubernetes liveness/readiness convention
	mux.HandleFunc("/image", imageHandler)

	log.Printf("image service listening on %s", listenAddr)
	if err := http.ListenAndServe(listenAddr, mux); err != nil {
		log.Fatal(err)
	}
}
