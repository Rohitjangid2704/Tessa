SELECT r.number AS room, count(*) AS open_issues
FROM issues i
JOIN rooms r ON r.id = i.room_id
WHERE i.status = 'open'
GROUP BY r.number
ORDER BY open_issues DESC, r.number
