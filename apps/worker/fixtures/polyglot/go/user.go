package store

type User struct {
	ID   int    `gorm:"primaryKey"`
	Name string `gorm:"size:200"`
}
