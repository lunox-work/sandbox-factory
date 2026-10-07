package com.example;

public class UserService {
    private final Repo repo;

    public UserService(Repo repo) {
        this.repo = repo;
    }

    public User find(long id) throws NotFound {
        return repo.find(id);
    }

    protected void audit(String message) {}

    private void hidden() {}

    public static final int LIMIT = 5;

    public enum Mode { FAST, SAFE }
}

interface Repo {
    User find(long id);
}
