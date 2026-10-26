$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$dotsPath=$env:DOTS_NEW_DIRECTORY
if(-not [IO.Path]::IsPathRooted($dotsPath) -or -not [IO.Directory]::Exists($dotsPath)){throw 'NEW_PRIVATE_DIRECTORY_REQUIRED'}
$dotsInfo=New-Object IO.DirectoryInfo($dotsPath)
for($dotsItem=$dotsInfo;$null-ne$dotsItem;$dotsItem=$dotsItem.Parent){if(($dotsItem.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'LINK_DIRECTORY_REFUSED'}}
if([IO.Directory]::GetFileSystemEntries($dotsPath).Length-ne0){throw 'EMPTY_NEW_DIRECTORY_REQUIRED'}
$dotsIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $dotsOwner=$dotsIdentity.User
    $dotsSystem=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $dotsIds=@($dotsOwner.Value,'S-1-5-18')|Select-Object -Unique
    $dotsAcl=New-Object Security.AccessControl.DirectorySecurity
    $dotsAcl.SetAccessRuleProtection($true,$false)
    $dotsAcl.SetOwner($dotsOwner)
    $dotsFlags=[Security.AccessControl.InheritanceFlags]::ContainerInherit-bor[Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach($dotsRecipient in @($dotsOwner,$dotsSystem)){
        $dotsRule=New-Object Security.AccessControl.FileSystemAccessRule($dotsRecipient,[Security.AccessControl.FileSystemRights]::FullControl,$dotsFlags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
        $dotsAcl.AddAccessRule($dotsRule)
    }
    [IO.Directory]::SetAccessControl($dotsPath,$dotsAcl)
    $dotsReadback=[IO.Directory]::GetAccessControl($dotsPath)
    $dotsRules=@($dotsReadback.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if(-not$dotsReadback.AreAccessRulesProtected-or$dotsReadback.GetOwner([Security.Principal.SecurityIdentifier]).Value-cne$dotsOwner.Value-or$dotsRules.Count-ne$dotsIds.Count){throw 'PRIVATE_DACL_READBACK_MISMATCH'}
    foreach($dotsRule in $dotsRules){
        if($dotsRule.IsInherited-or$dotsRule.IdentityReference.Value-cnotin$dotsIds-or$dotsRule.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or$dotsRule.FileSystemRights-ne[Security.AccessControl.FileSystemRights]::FullControl-or$dotsRule.InheritanceFlags-ne$dotsFlags-or$dotsRule.PropagationFlags-ne[Security.AccessControl.PropagationFlags]::None){throw 'PRIVATE_DACL_READBACK_MISMATCH'}
    }
} finally {$dotsIdentity.Dispose()}
