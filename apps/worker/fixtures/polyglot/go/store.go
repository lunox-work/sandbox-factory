package store

type Store interface {
	Get(id int) (*User, error)
}

func NewStore(dsn string) Store { return nil }

func helper() {}

func (u *User) Display(upper bool) string { return u.Name }

const (
	MaxUsers = 10
	minUsers = 1
)
