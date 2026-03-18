-- CreateTable
CREATE TABLE "EmployeePurchaseSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "employeeMarkupPercent" REAL NOT NULL DEFAULT 15,
    "consignmentCostPercent" REAL NOT NULL DEFAULT 50,
    "reservationDays" INTEGER NOT NULL DEFAULT 30,
    "notePrefix" TEXT NOT NULL DEFAULT 'Employee Purchase',
    "invoiceSubject" TEXT NOT NULL DEFAULT 'Employee Purchase Invoice',
    "updatedAt" DATETIME NOT NULL
);
