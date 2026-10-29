// UI tests open real (transparent) windows on the shared desktop; running the
// test classes in parallel lets dialogs from different threads compete for
// activation and timing. Run them one at a time.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
