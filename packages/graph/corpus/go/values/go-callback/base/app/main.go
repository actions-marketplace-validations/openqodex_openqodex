package app

import "example.com/shop/util"

func Main(xs []string) {
	util.Each(xs, Show)
}
