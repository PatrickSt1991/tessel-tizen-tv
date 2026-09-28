package smb

import (
	"reflect"
	"testing"
)

func TestVisibleSharesDropsHiddenAndSorts(t *testing.T) {
	got := visibleShares([]string{"media", "IPC$", "Films", "ADMIN$", "", "print$", "Backup"})
	want := []string{"Backup", "Films", "media"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("visibleShares = %v, want %v", got, want)
	}
}
