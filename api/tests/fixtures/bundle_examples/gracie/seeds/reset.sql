DELETE FROM smart_log_issue WHERE property_id = 'qa-property-1';
DELETE FROM room WHERE property_id = 'qa-property-1';
DELETE FROM property WHERE id = 'qa-property-1';
INSERT INTO property (id, name) VALUES ('qa-property-1', 'QA Hotel');
INSERT INTO room (id, property_id, room_number) VALUES (1, 'qa-property-1', '20001'), (2, 'qa-property-1', '20003');
INSERT INTO smart_log_issue (id, property_id, room_id, category, status, created_at)
VALUES (1, 'qa-property-1', 2, 'maintenance', 'open', '2026-09-01T08:00:00Z'),
       (2, 'qa-property-1', 2, 'maintenance', 'open', '2026-09-02T08:00:00Z'),
       (3, 'qa-property-1', 1, 'maintenance', 'closed', '2026-09-03T08:00:00Z');
