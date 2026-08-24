const { Router } = require("express");
const {
  addUser,
  fetchUsers,
  fetchUserById,
} = require("../controllers/userController");
const { requireStaffAuth } = require("../middleware/kindeAuth");

const router = Router();

// Public: called right after Kinde login, before the caller is a known StaffUser
router.post("/", addUser);

router.get("/", requireStaffAuth, fetchUsers);
router.get("/:id", requireStaffAuth, fetchUserById);

module.exports = router;
