// Maps addresses in a stripped Go Mach-O to function names, source file and
// line, from Go's own function table (__gopclntab). Phase 1 task 10 spike:
//   go build -o /tmp/gosym . && /tmp/gosym <binary> 0x1004950fc …
// Prints the table size, then "address entry name file:line" per address.

package main

import (
	"debug/gosym"
	"debug/macho"
	"fmt"
	"os"
	"strconv"
)

func main() {
	f, err := macho.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	sec := f.Section("__gopclntab")
	data, err := sec.Data()
	if err != nil {
		panic(err)
	}
	text := f.Section("__text")
	tab, err := gosym.NewTable(nil, gosym.NewLineTable(data, text.Addr))
	if err != nil {
		panic(err)
	}
	fmt.Println("functions in pclntab:", len(tab.Funcs))
	for _, a := range os.Args[2:] {
		pc, _ := strconv.ParseUint(a[2:], 16, 64)
		fn := tab.PCToFunc(pc)
		if fn == nil {
			fmt.Println(a, "-> (none)")
			continue
		}
		file, line, _ := tab.PCToLine(pc)
		fmt.Printf("%s %x %s %s:%d\n", a, fn.Entry, fn.Name, file, line)
	}
}
