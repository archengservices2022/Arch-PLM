using Arch.CadConnect.Core.Bom;

namespace Arch.CadConnect.Core.Tests.Bom;

/// <summary>Small builders for BOM test data.</summary>
internal static class BomFixtures
{
    public static BomRow Row(
        string? item,
        string? partNumber,
        decimal quantity = 1m,
        string? unit = "Each",
        string? description = null,
        string? material = null,
        BomMass? mass = null,
        BomStructure structure = BomStructure.Normal,
        BomSourceDocument? source = null,
        params BomRow[] children) => new()
        {
            ItemNumber = item,
            PartNumber = partNumber,
            Description = description,
            Quantity = new BomQuantity(quantity, unit),
            Material = material,
            Mass = mass,
            Structure = structure,
            Source = source ?? BomSourceDocument.Resolved((partNumber ?? "part") + ".ipt"),
            Children = children,
        };

    public static BomExtract Structured(params BomRow[] rows) => new()
    {
        ViewType = BomViewType.StructuredAllLevels,
        RootFileName = "top.iam",
        RootPartNumber = "TOP-100",
        Rows = rows,
    };

    public static BomExtract PartsOnly(params BomRow[] rows) => new()
    {
        ViewType = BomViewType.PartsOnly,
        RootFileName = "top.iam",
        RootPartNumber = "TOP-100",
        Rows = rows,
    };

    /// <summary>A realistic three-level structured BOM.</summary>
    public static BomExtract Frame() => Structured(
        Row("1", "BR-001", 2m, "Each", "Bracket", "Steel, Mild", new BomMass(0.85m, "kg")),
        Row("2", "SUB-200", 1m, "Each", "Hinge subassembly", null, new BomMass(1.2m, "kg"),
            BomStructure.Normal, BomSourceDocument.Resolved("sub-200.iam"),
            Row("2.1", "PIN-010", 4m, "Each", "Pin", "Stainless Steel", new BomMass(0.015m, "kg")),
            Row("2.2", "SCR-M6", 8m, "Each", "Screw M6x20", null, null, BomStructure.Purchased, BomSourceDocument.Resolved("ISO 4762 M6x20.ipt"))),
        Row("3", "TUBE-25", 1250.5m, "mm", "Square tube 25x25", "Aluminum 6061", new BomMass(2.75m, "kg")));
}
