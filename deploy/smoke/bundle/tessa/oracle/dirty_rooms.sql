SELECT number AS room, floor
FROM rooms
WHERE status = 'dirty'
ORDER BY number
