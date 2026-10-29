using System.Runtime.InteropServices;

using Arch.CadConnect.Core.CopyDesign.Apply;

using InventorApi = Inventor;

namespace Arch.CadConnect.Inventor.CopyDesign;

/// <summary>
/// P6 METADATA FIX: READ-ONLY access to a document's iProperties, shared by
/// <see cref="InventorCopyDesignMetadataNormalizer"/> (which reads/writes the
/// Part Number) and both verifiers (which snapshot every string iProperty so
/// <see cref="CopyDesignVerificationEvaluator"/> can reject temp-name leakage).
/// Never writes, never saves.
/// </summary>
internal static class InventorCopyDesignPropertyReader
{
    /// <summary>Inventor's internal (non-localized) name of the property set
    ///  shown as "Project" in the iProperties dialog.</summary>
    internal const string DesignTrackingPropertySetName = "Design Tracking Properties";

    /// <summary>Inventor's internal (non-localized) name of "Part Number".</summary>
    internal const string PartNumberPropertyName = "Part Number";

    /// <summary>Snapshots EVERY string-valued property in every property set of
    ///  <paramref name="document"/> into <paramref name="properties"/>.
    ///  Returns <c>false</c> (leaving <paramref name="properties"/> untouched)
    ///  if enumerating the sets/properties throws, OR if the critical Design
    ///  Tracking Part Number was not among the values read - so the caller
    ///  fails closed rather than trusting a partial snapshot. A single
    ///  property whose VALUE cannot be read (e.g. a binary thumbnail) is
    ///  skipped: it cannot carry a string, and Part Number's own presence is
    ///  required separately.</summary>
    public static bool TryGatherStringProperties(InventorApi.Document document, List<CopyDesignStringPropertyFact> properties)
    {
        var gathered = new List<CopyDesignStringPropertyFact>();
        try
        {
            foreach (InventorApi.PropertySet set in document.PropertySets)
            {
                var setName = set.Name;
                foreach (InventorApi.Property property in set)
                {
                    object? value;
                    try { value = property.Value; }
                    catch (COMException) { continue; }

                    if (value is string text)
                    {
                        gathered.Add(new CopyDesignStringPropertyFact(setName, property.Name, text));
                    }
                }
            }
        }
        catch (Exception ex) when (ex is COMException or InvalidComObjectException or InvalidCastException)
        {
            return false;
        }

        var partNumberRead = gathered.Any(p =>
            string.Equals(p.PropertySetName, DesignTrackingPropertySetName, StringComparison.Ordinal)
            && string.Equals(p.PropertyName, PartNumberPropertyName, StringComparison.Ordinal));
        if (!partNumberRead)
        {
            return false;
        }

        properties.AddRange(gathered);
        return true;
    }

    /// <summary>The Design Tracking "Part Number" property itself (for a
    ///  caller that may then write it). Throws a COM exception if Inventor
    ///  cannot resolve it - the caller fails closed on that.</summary>
    public static InventorApi.Property PartNumberProperty(InventorApi.Document document) =>
        document.PropertySets[DesignTrackingPropertySetName][PartNumberPropertyName];
}
