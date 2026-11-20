// Test oracle for Binlight's Go function table reader: Go's own debug/gosym.
//
//	gosym all <binary>          entry<TAB>name for every function
//	gosym at <binary> <pc>...   pc<TAB>entry<TAB>name<TAB>file<TAB>line
package main

import (
	"debug/elf"
	"debug/gosym"
	"debug/macho"
	"fmt"
	"os"
	"strconv"
)

func table(path string) *gosym.Table {
	var data []byte
	var text uint64
	if f, err := macho.Open(path); err == nil {
		d, err := f.Section("__gopclntab").Data()
		check(err)
		data, text = d, f.Section("__text").Addr
	} else {
		f, err := elf.Open(path)
		check(err)
		d, err := f.Section(".gopclntab").Data()
		check(err)
		data, text = d, f.Section(".text").Addr
	}
	tab, err := gosym.NewTable(nil, gosym.NewLineTable(data, text))
	check(err)
	return tab
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func main() {
	tab := table(os.Args[2])
	switch os.Args[1] {
	case "all":
		for _, f := range tab.Funcs {
			fmt.Printf("%x\t%s\n", f.Entry, f.Name)
		}
	case "at":
		for _, a := range os.Args[3:] {
			pc, err := strconv.ParseUint(a, 0, 64)
			check(err)
			fn := tab.PCToFunc(pc)
			if fn == nil {
				fmt.Printf("%x\t\t\t\t\n", pc)
				continue
			}
			file, line, _ := tab.PCToLine(pc)
			fmt.Printf("%x\t%x\t%s\t%s\t%d\n", pc, fn.Entry, fn.Name, file, line)
		}
	}
}
