DELETE FROM issues;
DELETE FROM rooms;

INSERT INTO rooms (id, number, floor, status) VALUES
    (1, '20001', 2, 'clean'),
    (2, '20002', 2, 'dirty'),
    (3, '20003', 2, 'dirty'),
    (4, '20004', 2, 'clean'),
    (5, '20005', 3, 'dirty'),
    (6, '20006', 3, 'clean'),
    (7, '20007', 3, 'clean'),
    (8, '20008', 3, 'clean');

INSERT INTO issues (id, room_id, description, status, created_at) VALUES
    (9101, 3, 'shower leaks', 'open', '2026-09-01T08:00:00Z'),
    (9102, 3, 'light flickers', 'open', '2026-09-02T08:00:00Z'),
    (9103, 5, 'tv remote missing', 'open', '2026-09-03T08:00:00Z'),
    (9104, 1, 'door sticks', 'closed', '2026-09-04T08:00:00Z'),
    (9105, 7, 'air conditioning is noisy', 'closed', '2026-09-05T08:00:00Z');
