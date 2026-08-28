SELECT r.number AS room, i.description, i.status
FROM issues i
JOIN rooms r ON r.id = i.room_id
WHERE i.description = :description
ORDER BY i.id
