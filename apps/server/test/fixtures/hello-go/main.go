// Contract-test target: a tiny Go program with a known URL literal, so
// REA's string, procedure and Go-module tools have something real to report.
package main

import (
	"fmt"
	"net/url"
)

const endpoint = "https://example.invalid/binlight-contract"

func main() {
	u, err := url.Parse(endpoint)
	if err != nil {
		panic(err)
	}
	fmt.Println("binlight contract fixture:", u.Host)
}
